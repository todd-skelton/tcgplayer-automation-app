use corten::{form::FieldName, prelude::*};

use crate::features::slab_pricing::url::Choice;

/// The rest of the screen's address, as hidden inputs, for a GET form that changes only some of
/// it: every field set but those in `except` (the form's own, and those its change resets).
/// Written by hand, field by field (corten#439).
#[component]
pub fn KeptChoice<'a>(choice: &'a Choice, except: &'a [FieldName]) -> impl Render {
    let kept: Vec<(FieldName, String)> = choice
        .pairs()
        .into_iter()
        .filter(|(name, _)| !except.iter().any(|e| e.as_str() == name.as_str()))
        .collect();
    html! {
        for (name, value) in kept {
            <input type="hidden" name={name} value={value}>
        }
    }
}
