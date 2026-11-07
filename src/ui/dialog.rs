// corten ui 0.1.0: dialog 1845545423d69ce2
//! A modal dialog's look, as the classes of the `<dialog>` you write, so its id, `open`,
//! `closedby` and `on:connect` are checked as always and a patch replaces the dialog itself. A
//! button opens it with no script, and another closes it:
//!
//! ```rust,ignore
//! <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }} type="button" command="show-modal" commandfor={RenameId}>"Rename"</button>
//! <dialog class={Dialog { size: DialogSize::Md }} id={RenameId} closedby="any" open={!errors.is_empty()} on:connect={dialog::modal(target)} on:corten:error={dialog::failed(event, target, said)}>
//!     <div class={DialogHeader {}}>
//!         <h2>"Rename the deck"</h2>
//!         <button class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }} type="button" command="close" commandfor={RenameId}>"Close"</button>
//!     </div>
//!     <p>"The new name shows everywhere the deck does."</p>
//!     <FailedAlert said={said} emphasis={AlertEmphasis::Soft}><p>{t.not_saved()}</p></FailedAlert>
//!     <form method="post" action={url::Rename} data-patch>..</form>
//!     <div class={DialogFooter {}}>
//!         <button class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Md }} type="button" command="close" commandfor={RenameId}>"Cancel"</button>
//!     </div>
//! </dialog>
//! ```
//!
//! `corten_ui::dialog::modal` (docs/guide/ui.md) makes a dialog the server drew open, after it
//! refused the form in it, modal. `corten_ui::dialog::failed` shows the dialog's own text (`said`)
//! when a `data-patch` submit in it gets no answer, where the toaster behind the dialog could not
//! be seen; the alert kit's `FailedAlert` gives that text the destructive alert's look.
//!
//! `size` is the most of a wide window it takes; on a narrow one it is the window's width less a
//! margin. A dialog taller than the window scrolls, its `DialogHeader` held at the top. The
//! header is the dialog's first element: its heading, then the controls the app writes at its end
//! (a `command="close"` button, or a link for a dialog the address opens), so their
//! `commandfor` or `href` is checked as always and the kit draws no close mark of its own.
use corten::prelude::*;

/// The most of a wide window the dialog takes. Each is a class in `dialog.css`, so a size without
/// a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DialogSize {
    /// 24rem: a question and its buttons.
    Sm,
    /// 32rem: a short form.
    Md,
    /// 48rem: a list to choose from, a picture.
    Lg,
    /// 64rem: a table, a review.
    Xl,
}

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Dialog() -> impl ClassList {
///     (Dialog, Fullscreen)
/// }
/// ```
#[component(css)]
pub fn Dialog(size: DialogSize) -> impl ClassList {
    let size = match size {
        DialogSize::Sm => Sm,
        DialogSize::Md => Md,
        DialogSize::Lg => Lg,
        DialogSize::Xl => Xl,
    };
    (Dialog, size)
}

/// The dialog's heading and the controls at its end, on the app's `<div>`, its first element (not a
/// `<header>`, which outside a section is the page's banner landmark).
#[component(css = Dialog)]
pub fn DialogHeader() -> impl ClassList {
    Header
}

/// The dialog's actions, at its end.
#[component(css = Dialog)]
pub fn DialogFooter() -> impl ClassList {
    Footer
}
