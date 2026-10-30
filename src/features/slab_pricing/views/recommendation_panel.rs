use chrono::{DateTime, Utc};
use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use crate::{
    features::slab_pricing::{
        actions::{CalculateInput, ReviewAskInput},
        identity::{Record, words},
        page::{Place, Screen},
        recommendation::{BASES, Calculation, Recommendation, Reference, amount},
        url,
        views::{Problem, PublicationPanel},
    },
    layout::{Field, Notice, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

/// The owned slab's recommendation: the costs it is calculated from, the market range and ask
/// it gave, how it used the evidence, and the ask the operator reviewed.
#[component(css = super::slab_screen::SlabScreen)]
pub fn RecommendationPanel<'a>(screen: &'a Screen, record: &'a Record, t: Msg) -> impl Render {
    let recommendation = screen.recommendation();
    let can_calculate = screen.can_calculate();
    let stale = screen.stale();
    let visitor = screen.visitor;
    let observed = screen
        .listing
        .as_ref()
        .and_then(|l| l.observed_at.parse::<DateTime<Utc>>().ok());
    html! {
        <section
            class={(panel(), Stack, RecommendationPanel)}
            aria-labelledby="slab-recommendation"
        >
            <h2 id="slab-recommendation">"Owned slab recommendation · USD"</h2>
            <p class={muted()}>
                "Blank costs stay unknown. Market value and your proposed item ask are calculated separately. Saved decisions do not publish prices to eBay."
            </p>
            if let Some(listing) = &screen.listing {
                <p class={muted()}>
                    "Listing "{&listing.snapshot.item_id}" · "{&listing.snapshot.title}
                    if let Some(at) = observed {
                        " · Observed "
                        {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                    }
                </p>
            }
            <CostsForm
                screen={screen}
                record={record}
                recommendation={recommendation}
                can_calculate={can_calculate}
            />
            if !can_calculate {
                <Notice tone={Tone::Info}>
                    "Confirm the owned identity, assign it to the selected listing if needed, and return to its grade to calculate."
                </Notice>
            }
            <Problem at={Place::Recommendation} why={screen.problem_at(Place::Recommendation)} />
            if let Some(recommendation) = recommendation {
                if stale {
                    <Notice tone={Tone::Warning}>
                        "Inputs or evidence changed. This saved recommendation needs recalculation."
                    </Notice>
                }
                <Outcome recommendation={recommendation} t={t} visitor={visitor} />
                <ReviewedAsk
                    screen={screen}
                    recommendation={recommendation}
                    allowed={can_calculate && !stale}
                />
                if let Some(listing) = &screen.listing {
                    <PublicationPanel
                        screen={screen}
                        listing={listing}
                        recommendation={recommendation}
                        stale={stale || !can_calculate}
                        t={t}
                    />
                }
            }
        </section>
    }
}

/// The comparable price basis and the seller's costs. The listing reviewed gives its ask and
/// shipping; the rest come from the last calculation.
#[component(css = super::slab_screen::SlabScreen)]
fn CostsForm<'a>(
    screen: &'a Screen,
    record: &'a Record,
    recommendation: Option<&'a Recommendation>,
    can_calculate: bool,
) -> impl Render {
    let f = CalculateInput::FIELDS;
    let before = recommendation.map(|r| &r.calculation);
    let seller = before.map(|c| c.seller.clone()).unwrap_or_default();
    let listing = screen.listing.as_ref();
    let current_ask = match listing {
        Some(listing) => listing.ask_in_usd(),
        None => seller.current_ask,
    };
    let shipping_charged = match listing {
        Some(listing) => listing.shipping_in_usd(),
        None => seller.shipping_charged,
    };
    let costs = [
        ("Current item ask (USD)", f.current_ask, current_ask),
        (
            "Shipping charged (USD)",
            f.shipping_charged,
            shipping_charged,
        ),
        ("Shipping cost (USD)", f.shipping_cost, seller.shipping_cost),
        (
            "Acquisition cost (USD)",
            f.acquisition_cost,
            seller.acquisition_cost,
        ),
        ("Minimum item ask (USD)", f.minimum_ask, seller.minimum_ask),
        (
            "Minimum profit (USD)",
            f.minimum_profit,
            seller.minimum_profit,
        ),
    ];
    let basis = before.map_or("item-plus-shipping", |c| c.policy.basis.as_str());
    let fees = seller.fees.as_ref();
    // A percentage from the saved fraction, without float noise (0.07 is 7, not 7.000000000000001).
    let fee_rate = number(fees.map(|f| (f.rate * 100.0 * 1e6).round() / 1e6));
    let fee_fixed = number(fees.map(|f| f.fixed));
    let fee_basis = fees.map_or_else(|| "item-plus-shipping".to_owned(), |f| f.basis.clone());
    html! {
        <form
            method="post"
            action={url::Calculate { choice: screen.choice.clone() }}
            data-patch
            class={Stack}
        >
            <div class={Line}>
                <Field label="Comparable price basis" hint="">
                    <BasisSelect name={f.basis} chosen={basis} />
                </Field>
                for (label, name, value) in costs {
                    <Field label={label} hint="">
                        <input type="number" name={name} value={number(value)} min="0" step="0.01">
                    </Field>
                }
            </div>
            <div class={Line}>
                <Field label="Seller fee (%)" hint="">
                    <input
                        type="number"
                        name={f.fee_rate}
                        value={fee_rate}
                        min="0"
                        max="99.99"
                        step="0.01"
                    >
                </Field>
                <Field label="Fixed fee (USD)" hint="">
                    <input
                        type="number"
                        name={f.fee_fixed}
                        value={fee_fixed}
                        min="0"
                        step="0.01"
                    >
                </Field>
                <Field label="Fee basis" hint="">
                    <BasisSelect name={f.fee_basis} chosen={fee_basis.as_str()} />
                </Field>
            </div>
            <div class={Line}>
                <button data-primary disabled={!can_calculate}>
                    "Calculate from saved evidence"
                </button>
                <small class={muted()}>{&record.grader}" "{&record.certificate_number}</small>
            </div>
        </form>
    }
}

#[component(css = super::slab_screen::SlabScreen)]
fn BasisSelect<'a>(name: FieldName, chosen: &'a str) -> impl Render {
    html! {
        <select name={name}>
            for (value, label) in BASES {
                <option value={value} selected={chosen == value}>{label}</option>
            }
        </select>
    }
}

/// What the calculation gave: the market range, the proposed ask, and why it may need review.
#[component(css = super::slab_screen::SlabScreen)]
fn Outcome<'a>(recommendation: &'a Recommendation, t: Msg, visitor: Visitor) -> impl Render {
    let c = &recommendation.calculation;
    let market = &c.market;
    let as_of = market.as_of.parse::<DateTime<Utc>>().ok();
    let flags = recommendation.flags();
    let (uncertain, rejected) = recommendation.uncertain_and_rejected();
    let tone = if c.ask.requires_review {
        Tone::Warning
    } else {
        Tone::Info
    };
    html! {
        <h3 class={Range}>
            match &market.range {
                Some(range) => {
                    {amount(Some(range.low))}"–"{amount(Some(range.high))}
                }
                None => "Insufficient comparable evidence",
            }
        </h3>
        <p class={muted()}>
            {words(&market.basis)}" market range · "{market.count}" accepted events · "
            {format!("{:.2}", market.effective_count)}" recency-weighted events"
            if let Some(at) = as_of {
                " · Calculated "
                {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
            }
        </p>
        if market.range.is_some() {
            <p class={muted()}>
                "The range describes the middle half of weighted observed sales; it is not a calibrated prediction interval."
            </p>
        }
        <p>"Proposed item ask: "{amount(c.ask.proposed_item_ask)}</p>
        <p class={muted()}>
            "Estimated proceeds: "{amount(c.ask.estimated_proceeds)}
            " · Estimated profit: "{amount(c.ask.estimated_profit)}
        </p>
        if let Some(span) = &market.observed_span {
            <p class={muted()}>
                "Observed sale span: "{amount(Some(span.low))}"–"{amount(Some(span.high))}
            </p>
        }
        if !flags.is_empty() {
            <Notice tone={tone}>
                {flags.iter().map(|code| words(code)).collect::<Vec<_>>().join("; ")}
            </Notice>
        }
        <p class={muted()}>
            {uncertain}" uncertain events · "{rejected}
            " excluded events. Review the source rows below for reasons."
        </p>
        <EvidenceUsed calculation={c} />
    }
}

/// Each sold event the calculation accepted, was unsure of, or left out, and why.
#[component(css = super::slab_screen::SlabScreen)]
fn EvidenceUsed<'a>(calculation: &'a Calculation) -> impl Render {
    let rows = decisions(calculation);
    html! {
        <details>
            <summary>"How this calculation used the evidence"</summary>
            <ol class={Decisions}>
                for row in &rows {
                    <li>{row}</li>
                }
            </ol>
            if rows.is_empty() {
                <p class={muted()}>"No comparable events were supplied."</p>
            }
        </details>
    }
}

/// One line per event, as the React panel wrote them: accepted comps, then the ones it was
/// unsure of or rejected, then the ones left out of the range.
fn decisions(c: &Calculation) -> Vec<String> {
    let refs = |references: &[Reference]| {
        references
            .iter()
            .map(|r| format!("{} {}", r.provider, r.provider_id))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let accepted = c.market.comps.iter().map(|comp| {
        format!(
            "Accepted: {} {:.2} on {}; recency weight {:.3}. {}",
            comp.currency,
            comp.amount,
            comp.date,
            comp.weight,
            refs(&comp.references)
        )
    });
    let disposed = c.dispositions.iter().map(|d| {
        let reasons: Vec<String> = d.reasons.iter().map(|r| words(r)).collect();
        format!(
            "{}: {}. {}",
            words(&d.status),
            reasons.join("; "),
            refs(&d.references)
        )
    });
    let excluded = c
        .market
        .excluded
        .iter()
        .map(|e| format!("Excluded from range: {}. {}", words(&e.reason), e.key));
    accepted.chain(disposed).chain(excluded).collect()
}

/// The ask the operator reviewed, and the form that saves another.
#[component(css = super::slab_screen::SlabScreen)]
fn ReviewedAsk<'a>(
    screen: &'a Screen,
    recommendation: &'a Recommendation,
    allowed: bool,
) -> impl Render {
    let f = ReviewAskInput::FIELDS;
    html! {
        if let Some(reviewed) = &recommendation.r#override {
            <Notice tone={Tone::Info}>
                "Reviewed item ask: "{&reviewed.currency}" "{format!("{:.2}", reviewed.item_price)}
                " · "{&reviewed.note}
                ". Proceeds and profit above belong to the original calculation."
            </Notice>
        }
        <form
            method="post"
            action={url::ReviewAsk { choice: screen.choice.clone() }}
            data-patch
            class={Line}
        >
            <input type="hidden" name={f.recommendation} value={&recommendation.id}>
            <Field label="Override item ask (USD)" hint="">
                <input type="number" name={f.item_price} min="0.01" step="0.01" required>
            </Field>
            <Field label="Override reason" hint="">
                <input name={f.note} maxlength="1000" required>
            </Field>
            <button disabled={!allowed}>"Save reviewed ask"</button>
        </form>
    }
}

/// An amount as a number input's value: `420.5`, or empty when unknown.
fn number(value: Option<f64>) -> String {
    value.map_or_else(String::new, |v| v.to_string())
}
