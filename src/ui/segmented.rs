//! The look of corten-ui's `ChoiceGroup` written inside it: its radio group as a segmented
//! control, the chosen option raised, as the kit's `Tabs` draws a tab list. The behavior and
//! markup are corten-ui's; this styles them by role and state.
//!
//! ```rust,ignore
//! <Segmented><ChoiceGroup choice={&window} label="Performance window" options={&options} /></Segmented>
//! ```
use corten::prelude::*;

#[component(css)]
pub fn Segmented<C: Render>(children: C) -> impl Render {
    html! { <div class={Segmented}>{children}</div> }
}
