/**
 * A stand-in for an HTMLVideoElement in tests of code that seeks one and
 * draws what it shows (`SeekableVideo`): no decoder, just the time.
 */
import type { SeekableVideo } from '../../src/lib/animate/frames';

/**
 * A media element that seeks (asynchronously, like a real one) and can fail.
 * `shown` is the time of the picture on screen, which is what a canvas draws.
 */
export class FakeVideo extends EventTarget implements SeekableVideo {
	#time = 0;
	shown = 0;
	seeking = false;
	readyState = 4;
	error: { code: number; message: string } | null = null;
	duration = 2;
	videoWidth = 640;
	videoHeight = 360;
	seeks: number[] = [];
	/** When false, seeks never finish (until the test fails or aborts them). */
	answers = true;

	get currentTime() {
		return this.#time;
	}

	set currentTime(time: number) {
		this.seeks.push(time);
		this.seeking = true;
		if (!this.answers) return;
		setTimeout(() => {
			this.#time = Math.min(time, Number.isFinite(this.duration) ? this.duration : 2);
			if (!Number.isFinite(this.duration) && time > 2) this.duration = 2;
			this.seeking = false;
			this.dispatchEvent(new Event('seeked'));
			this.present();
		}, 1);
	}

	/** Puts the seeked picture on screen (without frame callbacks, at once). */
	protected present() {
		this.shown = this.#time;
	}

	fail(code: number, message = '') {
		this.error = { code, message };
		this.dispatchEvent(new Event('error'));
	}
}
