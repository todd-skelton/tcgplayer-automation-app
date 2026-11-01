// corten ui 0.1.0: dialog e0094703492e3272
//! A modal dialog's look, on the `<dialog>` written inside it, so its id, `open`, `closedby`
//! and `on:connect` are checked as always. A button opens it with no script, and another closes
//! it:
//!
//! ```rust,ignore
//! <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
//!     <button type="button" command="show-modal" commandfor={RenameId}>"Rename"</button>
//! </Button>
//! <Dialog>
//!     <dialog id={RenameId} closedby="any" open={!errors.is_empty()} on:connect={dialog::modal(target)}>
//!         <h2>"Rename the deck"</h2>
//!         <p>"The new name shows everywhere the deck does."</p>
//!         <form method="post" action={url::Rename} data-patch>..</form>
//!         <DialogFooter>
//!             <Button variant={ButtonVariant::Ghost} size={ButtonSize::Md}>
//!                 <button type="button" command="close" commandfor={RenameId}>"Cancel"</button>
//!             </Button>
//!         </DialogFooter>
//!     </dialog>
//! </Dialog>
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
/// fn Dialog() -> impl Render {
///     html! { <div class={(Dialog, Fullscreen)}></div> }
/// }
/// ```
#[component(css)]
pub fn Dialog<C: Render>(children: C) -> impl Render {
    html! { <div class={Dialog}>{children}</div> }
}

/// The dialog's actions, at its end.
#[component(css = Dialog)]
pub fn DialogFooter<C: Render>(children: C) -> impl Render {
    html! { <div class={Footer}>{children}</div> }
}
