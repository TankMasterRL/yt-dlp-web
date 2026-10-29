/**
 * Hand a file to the person: the browser's save dialog where it has one
 * (showSaveFilePicker), else a plain download. Browser-only.
 */
export async function saveFile(file: Blob, name: string): Promise<void> {
	const picker = (
		window as {
			showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FileSystemFileHandle>;
		}
	).showSaveFilePicker;
	if (picker) {
		try {
			const handle = await picker({ suggestedName: name });
			const writable = await handle.createWritable();
			await writable.write(file);
			await writable.close();
			return;
		} catch (e) {
			if ((e as DOMException).name === 'AbortError') return;
			// Fall through to a plain download.
		}
	}
	const url = URL.createObjectURL(file);
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
