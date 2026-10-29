use corten::prelude::*;

use crate::features::pull_sheet::items::{Finish, Grade, Printing};

/// A card to pull, as a table row. A view: the filter reads `search`, and each column's sort
/// reads its field (`name`, `set`, `quantity`, ...) by name. The picture is a link to it, which
/// the sheet's one handler on the table body opens in a dialog instead.
#[component(view, css)]
pub fn ItemRow<'a>(
    key: usize,
    search: &'a str,
    name: &'a str,
    number: &'a str,
    set: &'a str,
    condition: &'a str,
    grade: Grade,
    printing: &'a Printing,
    rarity: &'a str,
    quantity: u32,
    product_line: &'a str,
    order: &'a str,
    picture: Option<String>,
    open: Ref<el::HTMLAnchorElement>,
) -> impl Render {
    let tone = match grade {
        Grade::NearMint => NearMint,
        Grade::LightlyPlayed => LightlyPlayed,
        Grade::ModeratelyPlayed => ModeratelyPlayed,
        Grade::HeavilyPlayed => HeavilyPlayed,
        Grade::Damaged => Damaged,
    };
    let finish = match printing.finish {
        Finish::Plain => None,
        Finish::Holo => Some(Holo),
        Finish::ReverseHolo => Some(ReverseHolo),
    };
    html! {
        <tr key={key} data-search={search} class={Row}>
            <td>
                if let Some(picture) = &picture {
                    <a
                        ref={open}
                        href={picture.as_str()}
                        target="_blank"
                        rel="noopener"
                        aria-label="View image"
                    >
                        "🖼"
                    </a>
                }
            </td>
            <td><span>{name}</span></td>
            <td>{number}</td>
            <td>{set}</td>
            <td>
                <span class={Chips}>
                    <span class={(Condition, tone)}>{condition}</span>
                    if let Some(label) = &printing.label {
                        <span class={(Printed, finish)}>{label}</span>
                    }
                </span>
            </td>
            <td>{rarity}</td>
            <td class={Number}>{quantity}</td>
            <td>{product_line}</td>
            <td><code>{order}</code></td>
        </tr>
    }
}
