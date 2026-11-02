// corten ui 0.1.0: dialog f837c8a3f0279d38
//! A modal dialog's look, as the classes of the `<dialog>` you write, so its id, `open`,
//! `closedby` and `on:connect` are checked as always and a patch replaces the dialog itself. A
//! button opens it with no script, and another closes it:
//!
//! ```rust,ignore
//! <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }} type="button" command="show-modal" commandfor={RenameId}>"Rename"</button>
//! <dialog class={Dialog {}} id={RenameId} closedby="any" open={!errors.is_empty()} on:connect={dialog::modal(target)}>
//!     <h2>"Rename the deck"</h2>
//!     <p>"The new name shows everywhere the deck does."</p>
//!     <form method="post" action={url::Rename} data-patch>..</form>
//!     <div class={DialogFooter {}}>
//!         <button class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Md }} type="button" command="close" commandfor={RenameId}>"Cancel"</button>
//!     </div>
//! </dialog>
//! ```
//!
//! `corten_ui::dialog::modal` (docs/guide/ui.md) makes a dialog the server drew open, after it
//! refused the form in it, modal.
use corten::prelude::*;

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
pub fn Dialog() -> impl ClassList {
    Dialog
}

/// The dialog's actions, at its end.
#[component(css = Dialog)]
pub fn DialogFooter() -> impl ClassList {
    Footer
}
