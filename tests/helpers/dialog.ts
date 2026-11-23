/**
 * <dialog>'s modal methods for jsdom, which has none: call `installDialog()`
 * before rendering, and the restore function it returns afterwards.
 * `showModal()` opens the dialog; `close()` closes it and fires `close`, as
 * browsers do (they fire it a task later; here it is at once).
 */
export function installDialog(): () => void {
	const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
	const { showModal, close } = proto;
	proto.showModal = function (this: HTMLDialogElement) {
		this.setAttribute('open', '');
	};
	proto.close = function (this: HTMLDialogElement) {
		if (!this.hasAttribute('open')) return;
		this.removeAttribute('open');
		this.dispatchEvent(new Event('close'));
	};
	return () => Object.assign(proto, { showModal, close });
}
