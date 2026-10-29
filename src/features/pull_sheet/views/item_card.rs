use corten::prelude::*;

use super::picture;
use crate::features::pull_sheet::items::{Finish, Grade, Item, Printing};

/// A card to pull, as its picture: the border and the panel colored by condition, a shimmer for
/// a holo or reverse holo, a badge for a first edition, and the quantity when more than one. A
/// click on the picture hides the details over it (a checkbox CSS reads, no script). A view, so
/// the sheet's filter and sort read its `search` text and move it by its key.
#[component(view, css)]
pub fn ItemCard<'a>(key: usize, search: &'a str, item: &'a Item) -> impl Render {
    let condition = item.shown_condition();
    let grade = match Grade::of(condition) {
        Grade::NearMint => NearMint,
        Grade::LightlyPlayed => LightlyPlayed,
        Grade::ModeratelyPlayed => ModeratelyPlayed,
        Grade::HeavilyPlayed => HeavilyPlayed,
        Grade::Damaged => Damaged,
    };
    let printing = Printing::of(item.variant());
    let finish = match printing.finish {
        Finish::Plain => None,
        Finish::Holo => Some(Holo),
        Finish::ReverseHolo => Some(ReverseHolo),
    };
    let first = printing.first_edition.then_some(FirstEdition);
    let name = item.display_name();
    let meta = [Some(item.set.as_str()), item.release_year.as_deref()]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    html! {
        <article key={key} data-search={search} class={(Card, grade, finish, first)}>
            if item.quantity > 1 {
                <span class={Quantity}>"x"{item.quantity}</span>
            }
            <label class={Face}>
                <input
                    type="checkbox"
                    class={HideDetails}
                    aria-label={format!("Hide details of {name}")}
                >
                match &item.catalog {
                    Some(sku) => <img src={picture(sku.product_id, "400x400")} alt={&name} loading="lazy">,
                    None => <span class={Missing} title="Product not found in database">"⚠"</span>,
                }
                if item.catalog.is_some() && finish.is_some() {
                    <span class={Shimmer}></span>
                }
                if printing.first_edition {
                    <span class={Badge}>"1st Ed"</span>
                }
                <span class={Details}>
                    <strong>{&name}</strong>
                    if !meta.is_empty() { <small>{&meta}</small> }
                    <span class={Chips}>
                        <span class={Condition}>{condition}</span>
                        if let Some(label) = &printing.label {
                            <span class={Printed}>{label}</span>
                        }
                    </span>
                    <small>{&item.product_line}" | "{&item.rarity}</small>
                </span>
            </label>
        </article>
    }
}
