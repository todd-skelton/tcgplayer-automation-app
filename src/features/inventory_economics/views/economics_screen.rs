use corten::{
    i18n::{Currency, Minor},
    prelude::*,
};

use crate::{
    features::inventory_economics::{
        url,
        workspace::{Order, Workspace},
    },
    layout::Notice,
    text::Msg,
    theme::*,
    ui::{
        alert::AlertVariant,
        card::{Card, CardContent, CardHeader},
        table::{Table, TableLayout, TableNumeric},
    },
};

/// The seller's current purchase costs, then each captured order's economics. Without a
/// workspace (no seller configured, the Node app down), why, and a way to read it again.
#[component(css)]
pub fn EconomicsScreen<'a>(workspace: &'a Result<Workspace, String>, t: Msg) -> impl Render {
    html! {
        <div class={EconomicsScreen}>
            match workspace {
                Err(why) => {
                    <Notice variant={AlertVariant::Warning}>
                        {why}" "<a href={url::InventoryEconomics}>"Retry"</a>
                    </Notice>
                }
                Ok(w) => {
                    <header>
                        <h1>"Inventory Economics"</h1>
                        <p class={muted()}>
                            "Estimated acquisition cost, reusable sale proceeds, and realized profit for "
                            {&w.seller_key}
                            "."
                        </p>
                    </header>
                    <div class={Card {}}>
                        <header class={CardHeader {}}><h2>"Purchase costs"</h2></header>
                        <div class={CardContent {}}>
                            let current = &w.purchase_costs;
                            if current.is_empty() {
                                <p class={muted()}>"No purchase cost records."</p>
                            } else {
                                <ul class={Costs}>
                                    for cost in current {
                                        <li key={&cost.id}>
                                            {&cost.purchase_reference}
                                            ": "
                                            <Money
                                                cents={Some(cost.total_amount_cents)}
                                                currency={&cost.currency}
                                                t={t}
                                            />
                                            <small>{cost.details()}</small>
                                        </li>
                                    }
                                </ul>
                            }
                        </div>
                    </div>
                    <OrderTable orders={&w.orders} t={t} />
                }
            }
        </div>
    }
}

/// Each order's money, from what the buyer paid to what it left after its cost.
#[component(css = EconomicsScreen)]
fn OrderTable<'a>(orders: &'a [Order], t: Msg) -> impl Render {
    html! {
        <div class={Card {}}>
            <div class={CardContent {}}>
                <Table layout={TableLayout::Scroll}>
                    <table aria-label="Order economics">
                        <thead>
                            <tr>
                                <th>"Order"</th>
                                <th class={TableNumeric {}}>"Gross"</th>
                                <th class={TableNumeric {}}>"Provider net"</th>
                                <th class={TableNumeric {}}>"Postage"</th>
                                <th class={TableNumeric {}}>"Cost"</th>
                                <th class={TableNumeric {}}>"Reusable cash"</th>
                                <th class={TableNumeric {}}>"Realized profit"</th>
                                <th>"Coverage"</th>
                            </tr>
                        </thead>
                        <tbody>
                            if orders.is_empty() {
                                <tr><td colspan="8">"No captured seller orders yet."</td></tr>
                            }
                            for o in orders {
                                <tr key={&o.order_number}>
                                    <th scope="row">{&o.order_number}</th>
                                    <td class={TableNumeric {}}>
                                        <Money
                                            cents={o.gross_order_cents}
                                            currency={&o.currency}
                                            t={t}
                                        />
                                    </td>
                                    <td class={TableNumeric {}}>
                                        <Money
                                            cents={o.provider_net_cents}
                                            currency={&o.currency}
                                            t={t}
                                        />
                                    </td>
                                    <td class={TableNumeric {}}>
                                        <Money
                                            cents={o.postage_cents}
                                            currency={&o.currency}
                                            t={t}
                                        />
                                    </td>
                                    <td class={TableNumeric {}}>
                                        <Money
                                            cents={o.acquisition_cost_cents}
                                            currency={&o.currency}
                                            t={t}
                                        />
                                    </td>
                                    <td class={TableNumeric {}}>
                                        <Money
                                            cents={o.reusable_cash_cents}
                                            currency={&o.currency}
                                            t={t}
                                        />
                                    </td>
                                    <td class={TableNumeric {}}>
                                        <Money
                                            cents={o.realized_profit_cents}
                                            currency={&o.currency}
                                            t={t}
                                        />
                                    </td>
                                    <td class={Coverage}>{o.coverage()}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            </div>
        </div>
    }
}

/// An amount in its own currency, or "Unknown" when there is none (or the code is not one).
#[component(css = EconomicsScreen)]
fn Money<'a>(cents: Option<i64>, currency: &'a str, t: Msg) -> impl Render {
    html! {
        match cents.zip(Currency::parse(currency)) {
            Some((c, code)) => { {t.money(Minor(c), code)} }
            None => { "Unknown" }
        }
    }
}
