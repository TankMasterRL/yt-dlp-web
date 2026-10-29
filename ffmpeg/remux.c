/*
 * The remux core's entry point: copy streams from input files into one
 * output container, over FFmpeg's own libraries — libavformat's demuxers and
 * muxers, libavcodec's parsers and bitstream filters. The build has no
 * decoders, encoders or filters, so a stream is only ever copied, whatever
 * its codec and whatever the containers.
 *
 * Why not the ffmpeg program itself: since FFmpeg 6.0 it requires threads,
 * and threads in WebAssembly require SharedArrayBuffer, which only a
 * cross-origin isolated page gets. This runs on the calling thread. Its copy
 * path mirrors ffmpeg's (fftools/ffmpeg_demux.c, ffmpeg_mux_init.c,
 * ffmpeg_mux.c): the same stream setup, timestamp handling and defaults, so a
 * command line means here what it means to ffmpeg. What it cannot do, it
 * refuses instead of doing something else.
 *
 *     remux_exec(argc, argv), argv as ffmpeg's without the program name:
 *
 *     [-hide_banner] [-nostdin] [-y] [-loglevel LEVEL]
 *     ([-f FORMAT] [-OPTION VALUE]... -i INPUT)...
 *     [-map [-]FILE[:STREAM_SPECIFIER][?]]...
 *     -c[:STREAM_SPECIFIER] copy... [-tag[:STREAM_SPECIFIER] TAG]...
 *     [-f FORMAT] [-OPTION VALUE]... OUTPUT
 *
 * -OPTION VALUE is an option of the (de)muxer or of libavformat itself
 * (-movflags +faststart, -probesize 1M, ...), for the file that follows it.
 * Without -map, the best video and the best audio stream are copied, picked
 * as ffmpeg picks them. What ffmpeg learns about a stream by decoding it is
 * read from its first frame instead (read_first_frames). Unlike ffmpeg, a
 * demuxing error fails the run instead of ending the file early. Returns 0,
 * or 1 once the reason has been logged.
 */
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/avutil.h"
#include "libavutil/channel_layout.h"
#include "libavutil/dict.h"
#include "libavutil/error.h"
#include "libavutil/log.h"
#include "libavutil/macros.h"
#include "libavutil/mathematics.h"
#include "libavutil/mem.h"
#include "libavutil/pixfmt.h"

typedef struct InputStream {
    /* DTS estimate, as ffmpeg keeps it (ist_dts_update), in AV_TIME_BASE. */
    int     saw_first_ts;
    int64_t dts, next_dts;
} InputStream;

typedef struct Input {
    const char      *url;
    const char      *format;
    AVDictionary    *options;
    AVFormatContext *ctx;
    InputStream     *streams;
    /* Added to every timestamp: the file starts at zero (AV_TIME_BASE). */
    int64_t          ts_offset;
    /* Of the last packet read (AV_TIME_BASE); the next read is from the
     * input furthest behind, so the output interleaves as it goes. */
    int64_t          last_dts;
    int              eof;
} Input;

typedef struct Map {
    const char *arg;
    int         file;
    char       *spec; /* NULL: every stream of the file */
    int         negative;
    int         optional;
} Map;

/* -c[:SPEC] copy, -tag[:SPEC] TAG. */
typedef struct PerStream {
    const char *spec; /* "" matches every stream */
    const char *value;
} PerStream;

typedef struct OutputStream {
    int      file, index; /* the input stream copied */
    int      removed;     /* by a later negative -map */
    int      started;
    int64_t  last_mux_dts;
    int64_t  rescale_delta_last;
    AVStream *st;
} OutputStream;

typedef struct Remux {
    Input           *inputs;
    int              nb_inputs;
    Map             *maps;
    int              nb_maps;
    PerStream       *codecs;
    int              nb_codecs;
    PerStream       *tags;
    int              nb_tags;
    OutputStream    *streams;
    int              nb_streams;
    const char      *output_url;
    const char      *output_format;
    AVDictionary    *output_options;
    AVFormatContext *out;
} Remux;

/* Appends one zeroed element to the array *array_ptr points to; NULL without
 * memory, the array left as it was. */
static void *append(void *array_ptr, int *nb, size_t size)
{
    char *grown = av_realloc_array(*(void **)array_ptr, *nb + 1, size);
    if (!grown)
        return NULL;
    *(void **)array_ptr = grown;
    memset(grown + *nb * size, 0, size);
    return grown + (*nb)++ * size;
}

/* "-c" → "", "-c:v:0" → "v:0", anything else → NULL. */
static const char *per_stream_spec(const char *name, const char *option)
{
    size_t len = strlen(option);
    if (strncmp(name, option, len))
        return NULL;
    if (!name[len])
        return "";
    return name[len] == ':' ? name + len + 1 : NULL;
}

static const char *codec_spec(const char *name)
{
    static const struct { const char *option, *spec; } shorthands[] = {
        { "vcodec", "v" }, { "acodec", "a" }, { "scodec", "s" }, { "dcodec", "d" },
    };
    const char *spec = per_stream_spec(name, "c");
    if (!spec)
        spec = per_stream_spec(name, "codec");
    for (int i = 0; !spec && i < FF_ARRAY_ELEMS(shorthands); i++)
        if (!strcmp(name, shorthands[i].option))
            spec = shorthands[i].spec;
    return spec;
}

static int parse_loglevel(const char *arg)
{
    static const struct { const char *name; int level; } levels[] = {
        { "quiet",   AV_LOG_QUIET   }, { "panic",   AV_LOG_PANIC   },
        { "fatal",   AV_LOG_FATAL   }, { "error",   AV_LOG_ERROR   },
        { "warning", AV_LOG_WARNING }, { "info",    AV_LOG_INFO    },
        { "verbose", AV_LOG_VERBOSE }, { "debug",   AV_LOG_DEBUG   },
        { "trace",   AV_LOG_TRACE   },
    };
    char *end;
    long level;

    for (int i = 0; i < FF_ARRAY_ELEMS(levels); i++)
        if (!strcmp(arg, levels[i].name))
            return levels[i].level;
    level = strtol(arg, &end, 10);
    return *arg && !*end && level >= INT_MIN + 1 && level <= INT_MAX ? level : INT_MIN;
}

/* [-]FILE[:STREAM_SPECIFIER][?] */
static int parse_map(Remux *r, const char *arg)
{
    const char *p = arg;
    char *end;
    long file;
    size_t len;
    Map *map = append(&r->maps, &r->nb_maps, sizeof(*map));

    if (!map)
        return AVERROR(ENOMEM);
    map->arg = arg;
    map->negative = *p == '-';
    p += map->negative;
    file = strtol(p, &end, 10);
    len = strlen(end);
    map->optional = len && end[len - 1] == '?';
    len -= map->optional;
    if (end == p || file < 0 || file > INT_MAX || (len && *end != ':')) {
        av_log(NULL, AV_LOG_ERROR, "Invalid stream map: %s\n", arg);
        return AVERROR(EINVAL);
    }
    map->file = file;
    if (len && !(map->spec = av_strndup(end + 1, len - 1)))
        return AVERROR(ENOMEM);
    return 0;
}

static int parse_args(Remux *r, int argc, char **argv)
{
    const char   *format  = NULL;
    AVDictionary *options = NULL;
    int ret = 0;

    for (int i = 0; i < argc; i++) {
        const char *name, *value, *spec;

        if (argv[i][0] != '-' || !argv[i][1]) {
            if (i != argc - 1) {
                av_log(NULL, AV_LOG_ERROR,
                       "Only one output file is supported, and it comes last: '%s'\n", argv[i]);
                ret = AVERROR(EINVAL);
                break;
            }
            r->output_url     = argv[i];
            r->output_format  = format;
            r->output_options = options;
            return 0;
        }
        name = argv[i] + 1;
        if (!strcmp(name, "hide_banner") || !strcmp(name, "nostdin") || !strcmp(name, "y"))
            continue;
        if (i + 1 >= argc) {
            av_log(NULL, AV_LOG_ERROR, "Missing argument for option '%s'.\n", name);
            ret = AVERROR(EINVAL);
            break;
        }
        value = argv[++i];

        if (!strcmp(name, "loglevel") || !strcmp(name, "v")) {
            int level = parse_loglevel(value);
            if (level == INT_MIN) {
                av_log(NULL, AV_LOG_ERROR, "Invalid loglevel \"%s\".\n", value);
                ret = AVERROR(EINVAL);
                break;
            }
            av_log_set_level(level);
        } else if (!strcmp(name, "i")) {
            Input *in = append(&r->inputs, &r->nb_inputs, sizeof(*in));
            if (!in) {
                ret = AVERROR(ENOMEM);
                break;
            }
            in->url     = value;
            in->format  = format;
            in->options = options;
            format  = NULL;
            options = NULL;
        } else if (!strcmp(name, "f")) {
            format = value;
        } else if (!strcmp(name, "map")) {
            if ((ret = parse_map(r, value)) < 0)
                break;
        } else if ((spec = codec_spec(name))) {
            PerStream *codec;
            if (strcmp(value, "copy")) {
                av_log(NULL, AV_LOG_ERROR,
                       "Cannot encode with '%s': this build has no encoders, it only copies streams "
                       "(-c copy).\n", value);
                ret = AVERROR(EINVAL);
                break;
            }
            if (!(codec = append(&r->codecs, &r->nb_codecs, sizeof(*codec)))) {
                ret = AVERROR(ENOMEM);
                break;
            }
            codec->spec  = spec;
            codec->value = value;
        } else if ((spec = per_stream_spec(name, "tag"))) {
            PerStream *tag = append(&r->tags, &r->nb_tags, sizeof(*tag));
            if (!tag) {
                ret = AVERROR(ENOMEM);
                break;
            }
            tag->spec  = spec;
            tag->value = value;
        } else if ((ret = av_dict_set(&options, name, value, 0)) < 0) {
            break;
        }
    }
    av_dict_free(&options);
    if (ret >= 0) {
        av_log(NULL, AV_LOG_ERROR, "At least one output file must be specified\n");
        ret = AVERROR(EINVAL);
    }
    return ret;
}

/* Options no (de)muxer took: ffmpeg refuses those too. */
static int check_options_used(const AVDictionary *options)
{
    const AVDictionaryEntry *unused = av_dict_iterate(options, NULL);
    if (!unused)
        return 0;
    av_log(NULL, AV_LOG_ERROR, "Option %s not found.\n", unused->key);
    return AVERROR_OPTION_NOT_FOUND;
}

/* Parameters only a stream's frames carry, which ffmpeg learns by decoding —
 * this build cannot — and which muxers need:
 * - AAC in ADTS (raw .aac, MPEG-TS, MPEG-PS): the sample rate and channels.
 *   FFmpeg's parser leaves them out (HE-AAC's differ), and without them no
 *   muxer takes the stream.
 * - VP9: the pixel format (bit depth, chroma subsampling). Without it, the MP4
 *   and FLV muxers write an empty vpcC box: an unplayable file.
 * They are read from the stream's first frame, as its decoder reports them. */
static int needs_first_frame(const AVStream *st)
{
    const AVCodecParameters *par = st->codecpar;
    return (par->codec_id == AV_CODEC_ID_AAC && par->sample_rate <= 0) ||
           (par->codec_id == AV_CODEC_ID_VP9 && par->format == AV_PIX_FMT_NONE);
}

typedef struct BitReader {
    const uint8_t *data;
    int size, pos; /* pos in bits; past the end reads zeros */
} BitReader;

static unsigned read_bits(BitReader *b, int n)
{
    unsigned value = 0;
    for (; n > 0; n--, b->pos++)
        value = value << 1 |
                (b->pos < b->size * 8 && b->data[b->pos >> 3] >> (7 - (b->pos & 7)) & 1);
    return value;
}

/* An ADTS header's sample rate and channels; its frames hold 1024 samples. */
static void read_adts_header(AVCodecParameters *par, const uint8_t *data, int size)
{
    static const int rates[] = {
        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    };
    BitReader b = { data, size };
    int rate, channels;

    /* The syncword; then the MPEG version (either), the layer (0) and whether
     * there is a CRC (either). */
    if (size < 7 || read_bits(&b, 12) != 0xfff || read_bits(&b, 4) >> 1 & 3)
        return;
    read_bits(&b, 2); /* profile */
    rate = read_bits(&b, 4);
    read_bits(&b, 1); /* private bit */
    channels = read_bits(&b, 3);
    if (rate >= FF_ARRAY_ELEMS(rates))
        return;
    par->sample_rate = rates[rate];
    par->frame_size  = 1024;
    /* 0: the layout is in a program config element instead. */
    if (channels && par->ch_layout.nb_channels <= 0)
        av_channel_layout_default(&par->ch_layout, channels == 7 ? 8 : channels);
}

/* A VP9 keyframe's uncompressed header: its pixel format and colours, as
 * FFmpeg's VP9 decoder derives them (read_colorspace_details in vp9.c). */
static void read_vp9_header(AVCodecParameters *par, const uint8_t *data, int size)
{
    static const enum AVColorSpace spaces[8] = {
        AVCOL_SPC_UNSPECIFIED, AVCOL_SPC_BT470BG, AVCOL_SPC_BT709, AVCOL_SPC_SMPTE170M,
        AVCOL_SPC_SMPTE240M, AVCOL_SPC_BT2020_NCL, AVCOL_SPC_RESERVED, AVCOL_SPC_RGB,
    };
    static const enum AVPixelFormat rgb[3] = {
        AV_PIX_FMT_GBRP, AV_PIX_FMT_GBRP10, AV_PIX_FMT_GBRP12,
    };
    /* By bit depth, vertical subsampling, horizontal subsampling. */
    static const enum AVPixelFormat yuv[3][2][2] = {
        { { AV_PIX_FMT_YUV444P,   AV_PIX_FMT_YUV422P   }, { AV_PIX_FMT_YUV440P,   AV_PIX_FMT_YUV420P   } },
        { { AV_PIX_FMT_YUV444P10, AV_PIX_FMT_YUV422P10 }, { AV_PIX_FMT_YUV440P10, AV_PIX_FMT_YUV420P10 } },
        { { AV_PIX_FMT_YUV444P12, AV_PIX_FMT_YUV422P12 }, { AV_PIX_FMT_YUV440P12, AV_PIX_FMT_YUV420P12 } },
    };
    BitReader b = { data, size };
    enum AVPixelFormat format;
    enum AVColorRange range;
    int profile, depth = 0, space;

    if (read_bits(&b, 2) != 2) /* frame marker */
        return;
    profile  = read_bits(&b, 1);
    profile |= read_bits(&b, 1) << 1;
    /* A reserved bit (profile 3), show_existing_frame, then frame_type: 0 is a keyframe. */
    if ((profile == 3 && read_bits(&b, 1)) || read_bits(&b, 1) || read_bits(&b, 1))
        return;
    read_bits(&b, 2); /* show_frame, error_resilient_mode */
    if (read_bits(&b, 24) != 0x498342) /* sync code */
        return;
    if (profile >= 2)
        depth = 1 + read_bits(&b, 1); /* 10 or 12 bits */
    space = read_bits(&b, 3);
    if (space == 7) { /* RGB: 4:4:4, profiles 1 and 3 only */
        if (!(profile & 1) || read_bits(&b, 1))
            return;
        format = rgb[depth];
        range  = AVCOL_RANGE_JPEG;
    } else {
        int ss_h = 1, ss_v = 1;
        range = read_bits(&b, 1) ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
        if (profile & 1) {
            ss_h = read_bits(&b, 1);
            ss_v = read_bits(&b, 1);
            /* 4:2:0 belongs to profiles 0 and 2; then a reserved bit. */
            if ((ss_h && ss_v) || read_bits(&b, 1))
                return;
        }
        format = yuv[depth][ss_v][ss_h];
    }
    if (b.pos > size * 8)
        return;
    par->format = format;
    if (par->profile == AV_PROFILE_UNKNOWN)
        par->profile = profile;
    if (par->color_space == AVCOL_SPC_UNSPECIFIED)
        par->color_space = spaces[space];
    if (par->color_range == AVCOL_RANGE_UNSPECIFIED)
        par->color_range = range;
}

/* The streams' first frames are read with a second demuxer, so the file is
 * still read from its start, before the streams are probed: ffmpeg's probing
 * then knows what a decoder would have told it. */
static int read_first_frames(Input *in)
{
    AVFormatContext *probe = NULL;
    AVPacket *pkt;
    int missing = 0, ret;

    for (unsigned i = 0; i < in->ctx->nb_streams; i++)
        missing += needs_first_frame(in->ctx->streams[i]);
    if (!missing)
        return 0;
    if ((ret = avformat_open_input(&probe, in->url, in->ctx->iformat, NULL)) < 0)
        return ret;
    if (!(pkt = av_packet_alloc())) {
        avformat_close_input(&probe);
        return AVERROR(ENOMEM);
    }
    for (unsigned i = 0; i < probe->nb_streams; i++)
        if (i >= in->ctx->nb_streams || !needs_first_frame(in->ctx->streams[i]))
            probe->streams[i]->discard = AVDISCARD_ALL;
    /* Bounded, in frames and in bytes: a stream with no usable frame early on
     * keeps its parameters unknown. */
    for (int reads = 0; missing && reads < 1000 && av_read_frame(probe, pkt) >= 0; reads++) {
        AVStream *st = pkt->stream_index < in->ctx->nb_streams
                           ? in->ctx->streams[pkt->stream_index] : NULL;
        if (st && needs_first_frame(st)) {
            if (st->codecpar->codec_id == AV_CODEC_ID_AAC)
                read_adts_header(st->codecpar, pkt->data, pkt->size);
            else
                read_vp9_header(st->codecpar, pkt->data, pkt->size);
            missing -= !needs_first_frame(st);
        }
        av_packet_unref(pkt);
        if (probe->pb && avio_tell(probe->pb) > 32 << 20)
            break;
    }
    av_packet_free(&pkt);
    avformat_close_input(&probe);
    return 0;
}

static int open_inputs(Remux *r)
{
    for (int i = 0; i < r->nb_inputs; i++) {
        Input *in = &r->inputs[i];
        const AVInputFormat *format = NULL;
        int ret;

        if (in->format && !(format = av_find_input_format(in->format))) {
            av_log(NULL, AV_LOG_ERROR, "Unknown input format: '%s'\n", in->format);
            return AVERROR(EINVAL);
        }
        ret = avformat_open_input(&in->ctx, in->url, format, &in->options);
        if (ret < 0) {
            av_log(NULL, AV_LOG_ERROR, "%s: %s\n", in->url, av_err2str(ret));
            return ret;
        }
        if ((ret = check_options_used(in->options)) < 0)
            return ret;
        if ((ret = read_first_frames(in)) < 0) {
            av_log(NULL, AV_LOG_ERROR, "%s: %s\n", in->url, av_err2str(ret));
            return ret;
        }
        /* Without decoders, parameters only headers and parsers carry stay
         * unknown; a copy needs none of them. */
        ret = avformat_find_stream_info(in->ctx, NULL);
        if (ret < 0 && !in->ctx->nb_streams) {
            av_log(NULL, AV_LOG_ERROR, "%s: could not find codec parameters\n", in->url);
            return ret;
        }
        in->streams = av_calloc(FFMAX(in->ctx->nb_streams, 1), sizeof(*in->streams));
        if (!in->streams)
            return AVERROR(ENOMEM);
        for (unsigned j = 0; j < in->ctx->nb_streams; j++)
            in->streams[j].next_dts = AV_NOPTS_VALUE;
        in->ts_offset = in->ctx->start_time == AV_NOPTS_VALUE ? 0 : -in->ctx->start_time;
        in->last_dts  = INT64_MIN;
        av_dump_format(in->ctx, i, in->url, 0);
    }
    return 0;
}

static int add_stream(Remux *r, int file, int index)
{
    OutputStream *os = append(&r->streams, &r->nb_streams, sizeof(*os));
    if (!os)
        return AVERROR(ENOMEM);
    os->file  = file;
    os->index = index;
    return 0;
}

/* ffmpeg's automatic selection (map_auto_video/map_auto_audio): the video
 * stream with the most pixels, the audio stream with the most channels. */
static int add_best_stream(Remux *r, enum AVMediaType type)
{
    const AVOutputFormat *ofmt = r->out->oformat;
    const int apic = MKTAG('A', 'P', 'I', 'C');
    int qcr = type == AVMEDIA_TYPE_VIDEO ? avformat_query_codec(ofmt, ofmt->video_codec, 0) : 0;
    int64_t best_score = 0;
    int best_file = -1, best_index = -1;

    if (av_guess_codec(ofmt, NULL, r->output_url, NULL, type) == AV_CODEC_ID_NONE)
        return 0;
    for (int f = 0; f < r->nb_inputs; f++) {
        AVFormatContext *ic = r->inputs[f].ctx;
        int64_t file_score = 0;
        int file_index = -1;

        for (unsigned i = 0; i < ic->nb_streams; i++) {
            const AVStream *st = ic->streams[i];
            const int attached = !!(st->disposition & AV_DISPOSITION_ATTACHED_PIC);
            int64_t score;

            if (st->codecpar->codec_type != type)
                continue;
            score = (type == AVMEDIA_TYPE_VIDEO
                         ? (int64_t)st->codecpar->width * st->codecpar->height
                         : st->codecpar->ch_layout.nb_channels) +
                    100000000 * !!(st->event_flags & AVSTREAM_EVENT_FLAG_NEW_PACKETS) +
                    5000000 * !!(st->disposition & AV_DISPOSITION_DEFAULT);
            if (qcr != apic && attached)
                score = 1;
            if (score > file_score) {
                if (qcr == apic && !attached)
                    continue;
                file_score = score;
                file_index = i;
            }
        }
        if (file_index >= 0) {
            const AVStream *st = ic->streams[file_index];
            if (qcr == apic || !(st->disposition & AV_DISPOSITION_ATTACHED_PIC))
                file_score -= 5000000 * !!(st->disposition & AV_DISPOSITION_DEFAULT);
            if (file_score > best_score) {
                best_score = file_score;
                best_file  = f;
                best_index = file_index;
            }
        }
    }
    return best_file < 0 ? 0 : add_stream(r, best_file, best_index);
}

static int map_streams(Remux *r)
{
    int kept = 0, ret;

    if (!r->nb_maps) {
        if ((ret = add_best_stream(r, AVMEDIA_TYPE_VIDEO)) < 0)
            return ret;
        return add_best_stream(r, AVMEDIA_TYPE_AUDIO);
    }
    for (int m = 0; m < r->nb_maps; m++) {
        const Map *map = &r->maps[m];
        AVFormatContext *ic;
        int matched = 0;

        if (map->file >= r->nb_inputs) {
            av_log(NULL, AV_LOG_ERROR, "Invalid input file index: %d.\n", map->file);
            return AVERROR(EINVAL);
        }
        ic = r->inputs[map->file].ctx;
        for (unsigned i = 0; i < ic->nb_streams; i++) {
            if (map->spec) {
                ret = avformat_match_stream_specifier(ic, ic->streams[i], map->spec);
                if (ret < 0) {
                    av_log(NULL, AV_LOG_ERROR, "Invalid stream specifier: %s\n", map->spec);
                    return ret;
                }
                if (!ret)
                    continue;
            }
            matched = 1;
            if (map->negative) {
                /* Removes what the maps before it added, as in ffmpeg. */
                for (int s = 0; s < r->nb_streams; s++)
                    if (r->streams[s].file == map->file && r->streams[s].index == i)
                        r->streams[s].removed = 1;
            } else if ((ret = add_stream(r, map->file, i)) < 0) {
                return ret;
            }
        }
        if (!matched && !map->negative && !map->optional) {
            av_log(NULL, AV_LOG_ERROR, "Stream map '%s' matches no streams.\n"
                   "To ignore this, add a trailing '?' to the map.\n", map->arg);
            return AVERROR(EINVAL);
        }
    }
    for (int s = 0; s < r->nb_streams; s++)
        if (!r->streams[s].removed)
            r->streams[kept++] = r->streams[s];
    r->nb_streams = kept;
    return 0;
}

/* ffmpeg's streamcopy_init(). */
static int init_output_stream(Remux *r, OutputStream *os)
{
    const AVStream *ist = r->inputs[os->file].ctx->streams[os->index];
    const struct AVCodecTag * const *tags = r->out->oformat->codec_tag;
    AVCodecParameters *par;
    unsigned int tag;
    int ret;

    if (!(os->st = avformat_new_stream(r->out, NULL)))
        return AVERROR(ENOMEM);
    par = os->st->codecpar;
    if ((ret = avcodec_parameters_copy(par, ist->codecpar)) < 0)
        return ret;
    /* The input's codec tag, only where the muxer means the same by it. */
    if (tags && av_codec_get_id(tags, par->codec_tag) != par->codec_id &&
        av_codec_get_tag2(tags, par->codec_id, &tag))
        par->codec_tag = 0;

    os->st->avg_frame_rate = ist->avg_frame_rate;
    /* The input's time base, reduced; the muxer may still choose another. */
    os->st->time_base   = av_add_q(ist->time_base, (AVRational){ 0, 1 });
    os->st->disposition = ist->disposition;
    if ((ret = av_dict_copy(&os->st->metadata, ist->metadata, AV_DICT_DONT_OVERWRITE)) < 0)
        return ret;

    switch (par->codec_type) {
    case AVMEDIA_TYPE_AUDIO:
        if ((par->block_align == 1 || par->block_align == 1152 || par->block_align == 576) &&
            par->codec_id == AV_CODEC_ID_MP3)
            par->block_align = 0;
        if (par->codec_id == AV_CODEC_ID_AC3)
            par->block_align = 0;
        /* Unordered channels get their count's usual layout, as a decoder
         * would have given them (and ffmpeg would copy): muxers write
         * unordered ones as unknown, and FFmpeg's FLV muxer aborts on them. */
        if (par->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC && par->ch_layout.nb_channels > 0)
            av_channel_layout_default(&par->ch_layout, par->ch_layout.nb_channels);
        break;
    case AVMEDIA_TYPE_VIDEO:
        if (ist->sample_aspect_ratio.num)
            par->sample_aspect_ratio = ist->sample_aspect_ratio;
        os->st->sample_aspect_ratio = par->sample_aspect_ratio;
        os->st->r_frame_rate = ist->r_frame_rate;
        break;
    default:
        break;
    }
    os->started            = 0;
    os->last_mux_dts       = AV_NOPTS_VALUE;
    os->rescale_delta_last = AV_NOPTS_VALUE;
    return 0;
}

static int matching(Remux *r, AVStream *st, const PerStream *option)
{
    int ret = *option->spec ? avformat_match_stream_specifier(r->out, st, option->spec) : 1;
    if (ret < 0)
        av_log(NULL, AV_LOG_ERROR, "Invalid stream specifier: %s\n", option->spec);
    return ret;
}

/* Every stream needs a -c copy that covers it: without one, ffmpeg would
 * encode it, which this build cannot. Then -tag, the last match winning. */
static int apply_per_stream_options(Remux *r)
{
    for (int s = 0; s < r->nb_streams; s++) {
        AVStream *st = r->streams[s].st;
        int copied = 0, ret;

        for (int c = 0; c < r->nb_codecs && !copied; c++) {
            if ((ret = matching(r, st, &r->codecs[c])) < 0)
                return ret;
            copied = ret;
        }
        if (!copied) {
            av_log(NULL, AV_LOG_ERROR,
                   "Output stream #%d (%s) would need an encoder, and this build has none: "
                   "add -c copy.\n", s, av_get_media_type_string(st->codecpar->codec_type));
            return AVERROR(EINVAL);
        }
        for (int t = 0; t < r->nb_tags; t++) {
            const char *value = r->tags[t].value;
            char *end;
            uint32_t tag;

            if ((ret = matching(r, st, &r->tags[t])) < 0)
                return ret;
            if (!ret)
                continue;
            /* A number, or up to four characters (as ffmpeg reads -tag). */
            tag = strtol(value, &end, 0);
            if (*end) {
                uint8_t fourcc[4] = { 0 };
                memcpy(fourcc, value, FFMIN(sizeof(fourcc), strlen(value)));
                tag = MKTAG(fourcc[0], fourcc[1], fourcc[2], fourcc[3]);
            }
            st->codecpar->codec_tag = tag;
        }
    }
    return 0;
}

/* ffmpeg's defaults: global metadata from the first input, chapters from
 * the first input that has any, and — for each type with several streams
 * and none marked default — the first stream of it marked default. */
static int copy_defaults(Remux *r)
{
    static const char *const dropped[] = {
        "creation_time", "company_name", "product_name", "product_version",
    };
    int has_default[AVMEDIA_TYPE_NB + 1] = { 0 }, count[AVMEDIA_TYPE_NB + 1] = { 0 };
    int ret;

    if ((ret = av_dict_copy(&r->out->metadata, r->inputs[0].ctx->metadata,
                            AV_DICT_DONT_OVERWRITE)) < 0)
        return ret;
    for (int i = 0; i < FF_ARRAY_ELEMS(dropped); i++)
        av_dict_set(&r->out->metadata, dropped[i], NULL, 0);

    for (int f = 0; f < r->nb_inputs; f++) {
        const Input *in = &r->inputs[f];
        if (!in->ctx->nb_chapters)
            continue;
        for (unsigned c = 0; c < in->ctx->nb_chapters; c++) {
            const AVChapter *from = in->ctx->chapters[c];
            const int64_t offset = av_rescale_q(-in->ts_offset, AV_TIME_BASE_Q, from->time_base);
            AVChapter *to, **chapters;

            if (from->end < offset)
                continue;
            chapters = av_realloc_array(r->out->chapters, r->out->nb_chapters + 1,
                                        sizeof(*chapters));
            if (!chapters)
                return AVERROR(ENOMEM);
            r->out->chapters = chapters;
            if (!(to = av_mallocz(sizeof(*to))))
                return AVERROR(ENOMEM);
            r->out->chapters[r->out->nb_chapters++] = to;
            to->id        = from->id;
            to->time_base = from->time_base;
            to->start     = FFMAX(0, from->start - offset);
            to->end       = from->end - offset;
            if ((ret = av_dict_copy(&to->metadata, from->metadata, 0)) < 0)
                return ret;
        }
        break;
    }

    for (int s = 0; s < r->nb_streams; s++) {
        const AVStream *st = r->streams[s].st;
        const int type = st->codecpar->codec_type + 1;
        count[type]++;
        has_default[type] |= !!(st->disposition & AV_DISPOSITION_DEFAULT);
    }
    for (int s = 0; s < r->nb_streams; s++) {
        AVStream *st = r->streams[s].st;
        const int type = st->codecpar->codec_type + 1;
        if (count[type] < 2 || has_default[type] || st->disposition & AV_DISPOSITION_ATTACHED_PIC)
            continue;
        st->disposition |= AV_DISPOSITION_DEFAULT;
        has_default[type] = 1;
    }
    return 0;
}

static int open_output(Remux *r)
{
    int ret = avformat_alloc_output_context2(&r->out, NULL, r->output_format, r->output_url);
    if (ret < 0)
        return ret; /* libavformat has said why */
    if ((ret = map_streams(r)) < 0)
        return ret;
    if (!r->nb_streams) {
        av_log(NULL, AV_LOG_ERROR, "Output file does not contain any stream\n");
        return AVERROR(EINVAL);
    }
    for (int s = 0; s < r->nb_streams; s++)
        if ((ret = init_output_stream(r, &r->streams[s])) < 0)
            return ret;
    if ((ret = apply_per_stream_options(r)) < 0 || (ret = copy_defaults(r)) < 0)
        return ret;

    /* Streams nothing copies are never read. */
    for (int f = 0; f < r->nb_inputs; f++) {
        AVFormatContext *ic = r->inputs[f].ctx;
        for (unsigned i = 0; i < ic->nb_streams; i++) {
            int used = 0;
            for (int s = 0; s < r->nb_streams && !used; s++)
                used = r->streams[s].file == f && r->streams[s].index == i;
            if (!used)
                ic->streams[i]->discard = AVDISCARD_ALL;
        }
    }

    av_dump_format(r->out, 0, r->output_url, 1);
    for (int s = 0; s < r->nb_streams; s++)
        av_log(NULL, AV_LOG_INFO, "Stream #%d:%d -> #0:%d (copy)\n",
               r->streams[s].file, r->streams[s].index, s);

    if (!(r->out->oformat->flags & AVFMT_NOFILE) &&
        (ret = avio_open(&r->out->pb, r->output_url, AVIO_FLAG_WRITE)) < 0) {
        av_log(NULL, AV_LOG_ERROR, "%s: %s\n", r->output_url, av_err2str(ret));
        return ret;
    }
    ret = avformat_write_header(r->out, &r->output_options);
    if (ret < 0) {
        av_log(NULL, AV_LOG_ERROR,
               "Could not write header (incorrect codec parameters ?): %s\n", av_err2str(ret));
        return ret;
    }
    return check_options_used(r->output_options);
}

/* ffmpeg's ist_dts_update(): the packet's DTS, estimated when it has none. */
static int64_t update_dts(InputStream *is, const AVStream *st, const AVPacket *pkt)
{
    const AVCodecParameters *par = st->codecpar;

    if (!is->saw_first_ts) {
        is->dts = st->avg_frame_rate.num
                      ? -par->video_delay * AV_TIME_BASE / av_q2d(st->avg_frame_rate)
                      : 0;
        if (pkt->pts != AV_NOPTS_VALUE)
            is->dts += av_rescale_q(pkt->pts, st->time_base, AV_TIME_BASE_Q);
        is->saw_first_ts = 1;
    }
    if (is->next_dts == AV_NOPTS_VALUE)
        is->next_dts = is->dts;
    if (pkt->dts != AV_NOPTS_VALUE)
        is->next_dts = is->dts = av_rescale_q(pkt->dts, st->time_base, AV_TIME_BASE_Q);
    is->dts = is->next_dts;

    switch (par->codec_type) {
    case AVMEDIA_TYPE_AUDIO:
        if (par->sample_rate)
            is->next_dts += (int64_t)AV_TIME_BASE * par->frame_size / par->sample_rate;
        else
            is->next_dts += av_rescale_q(pkt->duration, st->time_base, AV_TIME_BASE_Q);
        break;
    case AVMEDIA_TYPE_VIDEO:
        if (pkt->duration)
            is->next_dts += av_rescale_q(pkt->duration, st->time_base, AV_TIME_BASE_Q);
        else if (par->framerate.num)
            is->next_dts += av_rescale_q(1, av_inv_q(par->framerate), AV_TIME_BASE_Q);
        break;
    default:
        break;
    }
    return is->dts;
}

static int64_t median3(int64_t a, int64_t b, int64_t c)
{
    return FFMAX(FFMIN(a, b), FFMIN(FFMAX(a, b), c));
}

/* ffmpeg's of_streamcopy() and mux_fixup_ts(); takes ownership of pkt's data. */
static int write_packet(Remux *r, OutputStream *os, AVPacket *pkt, int64_t dts_est)
{
    const AVStream *ist = r->inputs[os->file].ctx->streams[os->index];
    AVStream *st = os->st;
    AVCodecParameters *par = st->codecpar;
    const AVRational tb = ist->time_base;
    const int type = par->codec_type;
    int ret;

    if (!os->started) {
        /* Nothing before the first keyframe, or before the start. */
        if (!(pkt->flags & AV_PKT_FLAG_KEY) ||
            (pkt->pts == AV_NOPTS_VALUE ? dts_est < 0 : pkt->pts < 0)) {
            av_packet_unref(pkt);
            return 0;
        }
        os->started = 1;
    }
    if (pkt->dts == AV_NOPTS_VALUE)
        pkt->dts = av_rescale_q(dts_est, AV_TIME_BASE_Q, tb);
    else if (type == AVMEDIA_TYPE_AUDIO)
        pkt->pts = pkt->dts;

    if (type == AVMEDIA_TYPE_AUDIO && par->sample_rate > 0) {
        /* Sample-accurate, even from a coarse input time base. */
        int duration = av_get_audio_frame_duration2(par, pkt->size);
        if (!duration)
            duration = par->frame_size;
        pkt->dts = av_rescale_delta(tb, pkt->dts, (AVRational){ 1, par->sample_rate },
                                    duration, &os->rescale_delta_last, st->time_base);
        pkt->pts      = pkt->dts;
        pkt->duration = av_rescale_q(pkt->duration, tb, st->time_base);
    } else {
        av_packet_rescale_ts(pkt, tb, st->time_base);
    }
    pkt->time_base = st->time_base;

    if (!(r->out->oformat->flags & AVFMT_NOTIMESTAMPS)) {
        if (pkt->dts != AV_NOPTS_VALUE && pkt->pts != AV_NOPTS_VALUE && pkt->dts > pkt->pts) {
            av_log(NULL, AV_LOG_WARNING, "Invalid DTS: %"PRId64" PTS: %"PRId64" in output "
                   "stream %d, replacing by guess\n", pkt->dts, pkt->pts, pkt->stream_index);
            pkt->pts = pkt->dts = median3(pkt->pts, pkt->dts,
                                          os->last_mux_dts == AV_NOPTS_VALUE
                                              ? INT64_MIN : os->last_mux_dts + 1);
        }
        if ((type == AVMEDIA_TYPE_AUDIO || type == AVMEDIA_TYPE_VIDEO ||
             type == AVMEDIA_TYPE_SUBTITLE) &&
            pkt->dts != AV_NOPTS_VALUE && os->last_mux_dts != AV_NOPTS_VALUE) {
            const int64_t max = os->last_mux_dts +
                                !(r->out->oformat->flags & AVFMT_TS_NONSTRICT);
            if (pkt->dts < max) {
                av_log(NULL, type == AVMEDIA_TYPE_VIDEO || max - pkt->dts > 2
                                 ? AV_LOG_WARNING : AV_LOG_DEBUG,
                       "Non-monotonic DTS in output stream %d; previous: %"PRId64", current: "
                       "%"PRId64"; changing to %"PRId64". This may result in incorrect "
                       "timestamps in the output file.\n",
                       (int)(os - r->streams), os->last_mux_dts, pkt->dts, max);
                if (pkt->pts >= pkt->dts)
                    pkt->pts = FFMAX(pkt->pts, max);
                pkt->dts = max;
            }
        }
    }
    os->last_mux_dts = pkt->dts;

    pkt->stream_index = st->index;
    pkt->pos = -1;
    ret = av_interleaved_write_frame(r->out, pkt);
    if (ret < 0)
        av_log(NULL, AV_LOG_ERROR, "Error submitting a packet to the muxer: %s\n",
               av_err2str(ret));
    return ret;
}

static int copy_packets(Remux *r)
{
    AVPacket *pkt = av_packet_alloc(), *copy = av_packet_alloc();
    int ret = 0;

    if (!pkt || !copy) {
        ret = AVERROR(ENOMEM);
        goto end;
    }
    for (;;) {
        Input *in = NULL;
        const AVStream *st;
        int64_t dts;

        for (int f = 0; f < r->nb_inputs; f++)
            if (!r->inputs[f].eof && (!in || r->inputs[f].last_dts < in->last_dts))
                in = &r->inputs[f];
        if (!in)
            break;
        ret = av_read_frame(in->ctx, pkt);
        if (ret == AVERROR_EOF) {
            in->eof = 1;
            continue;
        }
        if (ret < 0) {
            av_log(NULL, AV_LOG_ERROR, "%s: error during demuxing: %s\n", in->url,
                   av_err2str(ret));
            goto end;
        }
        /* A stream that appeared mid-file was never mapped. */
        if (pkt->stream_index >= in->ctx->nb_streams ||
            in->ctx->streams[pkt->stream_index]->discard == AVDISCARD_ALL) {
            av_packet_unref(pkt);
            continue;
        }
        st = in->ctx->streams[pkt->stream_index];

        /* ffmpeg's ts_fixup(): each input starts at zero. */
        if (pkt->dts != AV_NOPTS_VALUE)
            pkt->dts += av_rescale_q(in->ts_offset, AV_TIME_BASE_Q, st->time_base);
        if (pkt->pts != AV_NOPTS_VALUE)
            pkt->pts += av_rescale_q(in->ts_offset, AV_TIME_BASE_Q, st->time_base);
        dts = update_dts(&in->streams[pkt->stream_index], st, pkt);
        in->last_dts = dts;

        for (int s = 0; s < r->nb_streams && ret >= 0; s++) {
            OutputStream *os = &r->streams[s];
            if (os->file != in - r->inputs || os->index != pkt->stream_index)
                continue;
            if ((ret = av_packet_ref(copy, pkt)) >= 0)
                ret = write_packet(r, os, copy, dts);
            av_packet_unref(copy);
        }
        av_packet_unref(pkt);
        if (ret < 0)
            goto end;
    }
    ret = av_write_trailer(r->out);
    if (ret < 0)
        av_log(NULL, AV_LOG_ERROR, "Error writing trailer: %s\n", av_err2str(ret));

end:
    av_packet_free(&pkt);
    av_packet_free(&copy);
    return ret;
}

static void free_remux(Remux *r)
{
    for (int i = 0; i < r->nb_inputs; i++) {
        avformat_close_input(&r->inputs[i].ctx);
        av_dict_free(&r->inputs[i].options);
        av_freep(&r->inputs[i].streams);
    }
    av_freep(&r->inputs);
    for (int m = 0; m < r->nb_maps; m++)
        av_freep(&r->maps[m].spec);
    av_freep(&r->maps);
    av_freep(&r->codecs);
    av_freep(&r->tags);
    av_freep(&r->streams);
    if (r->out && !(r->out->oformat->flags & AVFMT_NOFILE))
        avio_closep(&r->out->pb);
    avformat_free_context(r->out);
    av_dict_free(&r->output_options);
}

EMSCRIPTEN_KEEPALIVE int remux_exec(int argc, char **argv)
{
    Remux r = { 0 };
    int ret;

    /* Every run starts from ffmpeg's defaults. */
    av_log_set_level(AV_LOG_INFO);
    av_log_set_flags(AV_LOG_SKIP_REPEATED);

    ret = parse_args(&r, argc, argv);
    if (ret >= 0 && !r.nb_inputs) {
        av_log(NULL, AV_LOG_ERROR, "At least one input file must be specified (-i)\n");
        ret = AVERROR(EINVAL);
    }
    if (ret >= 0 && !r.nb_codecs) {
        av_log(NULL, AV_LOG_ERROR,
               "This build only copies streams, so -c copy is required: without it, ffmpeg "
               "would encode.\n");
        ret = AVERROR(EINVAL);
    }
    if (ret >= 0)
        ret = open_inputs(&r);
    if (ret >= 0)
        ret = open_output(&r);
    if (ret >= 0)
        ret = copy_packets(&r);
    free_remux(&r);
    return ret < 0;
}
