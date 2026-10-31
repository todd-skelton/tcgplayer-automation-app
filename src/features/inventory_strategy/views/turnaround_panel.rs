use corten::{i18n::DateStyle, prelude::*};

use super::{
    format::{cents, days, fixed, instant},
    strategy_screen::{Chip, Mood, Stat},
};
use crate::{
    features::inventory_strategy::{
        actions::TurnaroundInput,
        screen::Screen,
        turnaround::{Confidence, EffectiveSource, Mode},
        turnaround_settings::MAXIMUM_MANUAL_DAYS,
        url::{self, View},
    },
    layout::{Field, Notice, SubmitsOnChange, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

/// The turnaround form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct TurnaroundFormId;

fn source_words(source: EffectiveSource) -> &'static str {
    match source {
        EffectiveSource::Manual => "manual",
        EffectiveSource::ObservedProductLine => "observed product line",
        EffectiveSource::ObservedSeller => "observed seller",
        EffectiveSource::ManualFallback => "manual fallback",
    }
}

fn confidence_word(confidence: Confidence) -> &'static str {
    match confidence {
        Confidence::High => "high",
        Confidence::Medium => "medium",
        Confidence::Low => "low",
        Confidence::Unavailable => "unavailable",
    }
}

/// How long sale proceeds take to come back as newly published inventory, and which turnaround
/// the capital-cycle model uses for this seller.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn TurnaroundPanel<'a>(
    screen: &'a Screen,
    input: &'a TurnaroundInput,
    errors: &'a Errors,
    t: Msg,
) -> impl Render {
    let selection = &screen.turnaround;
    let evidence = selection.evidence.as_ref();
    let fallback =
        selection.setting.mode == Mode::Observed && !selection.fallback_reasons.is_empty();
    let visitor = screen.visitor;
    html! {
        <section class={panel()} aria-labelledby="capital-turnaround">
            <div class={Title}>
                <h2 id="capital-turnaround">"Capital turnaround"</h2>
                <Chip
                    mood={if selection.effective_source == EffectiveSource::ManualFallback { Mood::Caution } else { Mood::Good }}
                    label={&format!(
                        "Using {} days \u{b7} {}",
                        fixed(selection.effective_days, 1),
                        source_words(selection.effective_source)
                    )}
                />
            </div>
            <p class={muted()}>
                "Days from a sale until its proceeds are back on sale as replacement inventory, estimated from the last 90 days of completed cycles."
            </p>
            <div class={Stats}>
                <Stat
                    label="Typical"
                    value={&days(evidence.and_then(|e| e.typical_days), "Unavailable")}
                    detail="Dollar-weighted mean of completed cycles"
                />
                <Stat
                    label="Slower"
                    value={&days(evidence.and_then(|e| e.slower_days), "Unavailable")}
                    detail="Dollar-weighted p90 scenario, not a confidence bound"
                />
                <Stat
                    label="Evidence"
                    value={&evidence.map_or_else(|| "None".to_owned(), |e| format!("{} purchases", e.completed_purchase_count))}
                    detail={&evidence.map_or_else(
                        || "No completed sale-to-publication cycles yet".to_owned(),
                        |e| format!(
                            "{} confidence \u{b7} {} completed",
                            confidence_word(e.confidence),
                            cents(t, e.completed_cents)
                        ),
                    )}
                />
                <Stat
                    label="Waiting"
                    value={&evidence.map_or_else(|| "Unavailable".to_owned(), |e| cents(t, e.waiting_cents))}
                    detail={&evidence.and_then(|e| e.oldest_waiting_days).map_or_else(
                        || "Proceeds not yet republished".to_owned(),
                        |d| format!("Proceeds not yet republished \u{b7} oldest {} days", fixed(d, 1)),
                    )}
                />
            </div>
            <TurnaroundForm view={&screen.view} input={input} errors={errors} />
            if let Some(error) = &screen.reinvestment_error {
                <Notice tone={Tone::Warning}>{error}</Notice>
            }
            if let Some(error) = screen.settings_error {
                <Notice tone={Tone::Warning}>{error}</Notice>
            }
            if fallback {
                <Notice tone={Tone::Info}>
                    "Manual days retained: "{selection.fallback_reasons.join(" ")}
                </Notice>
            }
            if let Some(e) = evidence {
                <p class={(muted(), Caption)}>
                    "Evidence as of "
                    <Day at={Some(&e.report_as_of)} t={t} visitor={visitor} />
                    " \u{b7} sale cohort "
                    <Day at={e.observation_from.as_deref()} t={t} visitor={visitor} />
                    " to "
                    <Day at={e.observation_through.as_deref()} t={t} visitor={visitor} />
                    " \u{b7} costs, proceeds, and timing are estimated where records are missing."
                </p>
            }
        </section>
    }
}

/// A day in the visitor's zone, or "unavailable".
#[component]
fn Day<'a>(at: Option<&'a str>, t: Msg, visitor: Visitor) -> impl Render {
    html! {
        match at.and_then(instant) {
            Some(at) => { {t.date(at, DateStyle::Short).zone(visitor)} }
            None => { "unavailable" }
        }
    }
}

/// The turnaround source and the manual days, saved as either changes. Without a configured
/// seller there is nothing to save them for.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn TurnaroundForm<'a>(
    view: &'a View,
    input: &'a TurnaroundInput,
    errors: &'a Errors,
) -> impl Patch {
    let (f, e) = (TurnaroundInput::FIELDS, errors.within(TurnaroundFormId));
    let off = input.seller_key.is_empty();
    html! {
        <form
            id={TurnaroundFormId}
            method="post"
            action={url::SaveTurnaround { view: view.clone() }}
            data-patch
            class={TurnaroundForm}
        >
            {errors.form_message()}
            <input type="hidden" name={f.seller_key} value={&input.seller_key}>
            <SubmitsOnChange>
                <div class={Line}>
                    <fieldset class={WindowChoice} disabled={off}>
                        <legend class={VisuallyHidden}>"Turnaround source"</legend>
                        <label>
                            <input
                                type="radio"
                                name={f.mode}
                                value="observed"
                                checked={input.mode == "observed"}
                            >
                            <span>"Observed"</span>
                        </label>
                        <label>
                            <input
                                type="radio"
                                name={f.mode}
                                value="manual"
                                checked={input.mode == "manual"}
                            >
                            <span>"Manual"</span>
                        </label>
                    </fieldset>
                    <Field
                        label="Manual days"
                        hint="Used when manual is selected or observed evidence is too thin"
                    >
                        <input
                            type="number"
                            min="0"
                            max={MAXIMUM_MANUAL_DAYS}
                            step="1"
                            name={f.manual_turnaround_days}
                            value={&input.manual_turnaround_days}
                            disabled={off}
                            {..e.aria(f.manual_turnaround_days)}
                        >
                        {e.message(f.manual_turnaround_days)}
                    </Field>
                    <noscript><button disabled={off}>"Save"</button></noscript>
                </div>
            </SubmitsOnChange>
        </form>
    }
}
