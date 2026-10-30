use corten::prelude::*;

use crate::{
    features::batch_pricer::{
        batches::{Candidate, Publications},
        page::PublishInput,
        url,
    },
    text::Msg,
    theme::*,
};

/// The dialog's id: the Publish button opens it.
#[derive(Id)]
pub struct PublishDialogId;
#[derive(Id)]
struct PublishHeadingId;

/// The SKUs ready to publish, the smallest price change first, each to check. The recommended
/// ones are checked: every inventory change, or the 20 smallest price changes when there is none.
/// "Reset recommended selection" is the form's reset, so it works without a script; the script
/// adds checking all or none, and keeps the count, the quantity change and the button's words up
/// to date. Without it they say what is recommended.
#[component(css, js)]
pub fn PublishDialog<'a>(batch: i32, publications: &'a Publications, t: Msg) -> impl Render {
    let ready = publications.ready();
    let recommended = publications.recommended();
    let (count, delta) = ready
        .iter()
        .filter(|c| recommended.contains(&c.sku))
        .fold((0, 0), |(n, d), c| (n + 1, d + c.quantity_delta));
    let (items, note, submit, tools) = refs();
    let selection = js::Selection {
        items,
        note,
        submit,
        selected: t.js().batch_pricer_selected(),
        publish: t.js().batch_pricer_publish(),
        number: t.js().number(),
    };
    html! {
        <dialog id={PublishDialogId} aria-labelledby={PublishHeadingId} class={PublishDialog}>
            <form
                method="post"
                action={url::Publish { batch }}
                data-patch
                on:connect={js::start(selection, tools)}
                on:change={js::count(selection)}
                on:reset={js::afterReset(selection)}
            >
                <h2 id={PublishHeadingId}>"Select Batch "{batch}" Seller Portal Publication"</h2>
                <p>
                    "This stages the exact price and quantity changes shown below, then publishes them in automatic groups of no more than 250 SKUs. Positive quantities are additions, not absolute stock counts. An ambiguous response is never replayed automatically."
                </p>
                <p
                    class={Selection}
                    data-changes={if delta != 0 { "true" } else { "false" }}
                    role="status"
                >
                    <span ref={note}>
                        {t.batch_pricer_selected(count, format!("{delta:+}"))}
                    </span>
                    " Inventory changes are selected by default so the published quantity matches the batch. Price-only batches default to the 20 smallest price changes."
                </p>
                <div class={row(Space::_2)}>
                    <button type="reset">"Reset recommended selection"</button>
                    <span ref={tools} hidden class={row(Space::_2)}>
                        <button type="button" on:click={js::checkAll(selection, true)}>
                            "Select all ready"
                        </button>
                        <button type="button" on:click={js::checkAll(selection, false)}>
                            "Clear selection"
                        </button>
                    </span>
                </div>
                <ul ref={items} class={Items}>
                    for candidate in &ready {
                        <PublishItem
                            key={candidate.sku}
                            delta={candidate.quantity_delta}
                            checked={recommended.contains(&candidate.sku)}
                            candidate={describe(candidate)}
                        />
                    }
                </ul>
                <div class={(row(Space::_2), Footer)}>
                    <button type="button" command="close" commandfor={PublishDialogId}>
                        "Cancel"
                    </button>
                    <button ref={submit} class={Publish} disabled={count == 0}>
                        "Publish "{count}" SKUs"
                    </button>
                </div>
            </form>
        </dialog>
    }
}

/// A candidate's words: its name, its SKU line and its price change.
pub struct Described {
    name: String,
    detail: String,
    change: String,
}

fn describe(c: &Candidate) -> Described {
    let price = |p: Option<f64>, none: &str| p.map_or(none.to_owned(), |p| format!("${p:.2}"));
    Described {
        name: c
            .product_name
            .clone()
            .unwrap_or_else(|| format!("Product {}", c.product_id)),
        detail: format!(
            "SKU {} · Product {} · Condition {}",
            c.sku, c.product_id, c.condition
        ),
        change: format!(
            "{} → {}",
            price(c.previous_price, "New"),
            price(c.desired_price, "Unavailable")
        ),
    }
}

/// A SKU ready to publish, to check. A view: the script reads its `delta`, the quantity it adds
/// (or takes away), to total what is checked.
#[component(view, css = PublishDialog)]
pub fn PublishItem(key: i64, delta: i64, checked: bool, candidate: Described) -> impl Render {
    html! {
        <li key={key} data-delta={delta}>
            <label>
                <input
                    type="checkbox"
                    name={PublishInput::FIELDS.sku}
                    value={key}
                    checked={checked}
                    aria-label={format!("Select SKU {key}")}
                >
                <span>
                    <strong>{&candidate.name}</strong>
                    <small>{&candidate.detail}</small>
                </span>
            </label>
            <span class={row(Space::_2)}>
                <span>{&candidate.change}</span>
                <span>"Qty "{format!("{delta:+}")}</span>
                <span class={Ready}>"Ready"</span>
            </span>
        </li>
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::batch_pricer::batches::Preview;

    fn candidate(sku: i64, before: f64, after: f64, delta: i64) -> Candidate {
        Candidate {
            sku,
            product_id: 7,
            product_name: Some(format!("Card {sku}")),
            condition: "Near Mint".into(),
            previous_price: Some(before),
            desired_price: Some(after),
            quantity_delta: delta,
            eligible: true,
            reasons: Vec::new(),
        }
    }

    /// The recommended SKUs are checked and counted before any script runs.
    #[test]
    fn the_recommended_skus_start_checked_and_counted() {
        let items = vec![
            candidate(1, 1.0, 1.5, 0),
            candidate(2, 2.0, 2.1, 3),
            candidate(3, 3.0, 3.2, -1),
        ];
        let publications = Publications {
            preview: Some(Preview {
                planning_key: "k".into(),
                eligible_count: 3,
                excluded_count: 0,
                items,
            }),
            publications: Vec::new(),
        };
        let html = PublishDialog {
            batch: 9,
            publications: &publications,
            t: Msg::default(),
        }
        .to_html();
        let checked = |sku: i64| html.contains(&format!(r#"value="{sku}" checked"#));
        assert!(!checked(1) && checked(2) && checked(3), "{html}");
        assert!(
            html.contains("Selected 2 SKUs; total quantity delta +2."),
            "{html}"
        );
        assert!(html.contains("Publish 2 SKUs"), "{html}");
        assert!(html.contains(r#"data-delta="-1""#), "{html}");
    }
}
