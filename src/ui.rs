// corten ui 0.1.0
//! The design system's components: the Corten UI kit's, which `corten ui add` copied into
//! `src/ui/` and are the app's to change, and the app's own built from them. Their colors, spacing
//! and corners are the app's one token file (`crate::theme`, `tokens/`), whose color names are the
//! kit's (`--background`, `--primary`, ...) with the tones an operator screen needs added
//! (`--success`, `--warning`, `--info`, each with `-foreground` and `-soft`).

use corten::Component;

pub mod accordion;
pub mod alert;
pub mod avatar;
pub mod badge;
pub mod breadcrumb;
pub mod button;
pub mod card;
pub mod checkbox;
pub mod checkboxes;
pub mod combobox;
pub mod control_width;
pub mod dialog;
pub mod dropdown_menu;
pub mod field;
pub mod icon;
pub mod input;
pub mod input_group;
pub mod nav_bar;
pub mod pagination;
pub mod popover;
pub mod progress;
pub mod radio_group;
pub mod segmented;
pub mod select;
pub mod separator;
pub mod sheet;
pub mod skeleton;
pub mod slider;
pub mod stats;
pub mod status_dot;
pub mod stepper;
pub mod steps;
pub mod switch;
pub mod table;
pub mod tabs;
pub mod textarea;
pub mod tip;
pub mod toasts;
pub mod visually_hidden;

/// Each component with a stylesheet, after the tokens: `App::components(ui::COMPONENTS)`.
pub const COMPONENTS: &[Component] = &[
    accordion::Accordion,
    alert::Alert,
    avatar::Avatar,
    badge::Badge,
    breadcrumb::Breadcrumb,
    button::Button,
    card::Card,
    checkbox::Checkbox,
    checkboxes::Checkboxes,
    combobox::Combobox,
    control_width::ControlWidth,
    dialog::Dialog,
    dropdown_menu::DropdownMenu,
    field::Field,
    icon::Icon,
    input::Input,
    input_group::InputGroup,
    nav_bar::NavBar,
    pagination::Pagination,
    popover::Popover,
    progress::Progress,
    radio_group::RadioGroup,
    segmented::Segmented,
    select::Select,
    separator::Separator,
    sheet::Sheet,
    skeleton::Skeleton,
    slider::Slider,
    stats::Stats,
    status_dot::StatusDot,
    stepper::Stepper,
    steps::Steps,
    switch::Switch,
    table::Table,
    tabs::Tabs,
    textarea::Textarea,
    tip::Tip,
    toasts::Toasts,
    visually_hidden::VisuallyHidden,
];

/// Asserts each `<label for>` in `html` names exactly one element's id: a kit `Field` is given its
/// control's id apart from the control, so a page's test checks the two agree. Returns the count.
#[cfg(test)]
pub fn assert_labels_name_their_controls(html: &str) -> usize {
    let starts: Vec<usize> = html
        .match_indices("<label for=\"")
        .map(|(at, _)| at + 12)
        .collect();
    for at in &starts {
        let id = &html[*at..];
        let id = &id[..id.find('"').unwrap()];
        assert_eq!(
            html.matches(&format!(" id=\"{id}\"")).count(),
            1,
            "label for {id}: {html}"
        );
    }
    starts.len()
}
