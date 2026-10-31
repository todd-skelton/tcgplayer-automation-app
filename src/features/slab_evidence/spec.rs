//! An evidence request, ported from `evidenceRefresh.ts` and `evidenceKey`: checked and written
//! the one way Node writes it, so the key it is kept under is the one Node computes.
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Why a request was refused, in words the operator sees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn refused<T>(message: &str) -> Result<T, Refused> {
    Err(Refused(message.to_owned()))
}

/// Sale dates, as `YYYY-MM-DD`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub from: String,
    pub to: String,
}

impl Window {
    /// `evidenceWindow`: two calendar dates in order, at most 3660 days apart.
    pub fn checked(&self) -> Result<Window, Refused> {
        let date = |text: &str| {
            let shaped = text.len() == 10
                && text.bytes().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                });
            shaped
                .then(|| NaiveDate::parse_from_str(text, "%Y-%m-%d").ok())
                .flatten()
        };
        let (Some(from), Some(to)) = (date(&self.from), date(&self.to)) else {
            return refused("Provide an explicit evidence date window.");
        };
        if from > to || (to - from).num_days() > 3660 {
            return refused("Evidence window is out of range.");
        }
        Ok(self.clone())
    }
}

/// A page of an eBay source: the sold or unsold listings for a search.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EbayPage {
    pub group_key: String,
    pub keywords: String,
    pub window: Window,
    pub offset: i64,
    pub limit: i64,
    pub timezone: String,
}

/// What to read: field order is Node's, which the key hashes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Spec {
    #[serde(rename = "alt-sales", rename_all = "camelCase")]
    AltSales {
        asset_id: String,
        window: Window,
        limit_per_grade: i64,
    },
    #[serde(rename = "alt-supply", rename_all = "camelCase")]
    AltSupply { asset_id: String },
    #[serde(rename = "alt-sale-detail", rename_all = "camelCase")]
    AltSaleDetail { transaction_id: String },
    #[serde(rename = "ebay-sales")]
    EbaySales(EbayPage),
    #[serde(rename = "ebay-supply")]
    EbaySupply(EbayPage),
}

/// JavaScript's `\s`: Unicode white space and the byte order mark.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn reference(value: &str) -> Result<String, Refused> {
    let fits = (1..=80).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if fits {
        Ok(value.to_owned())
    } else {
        refused("Provide a valid provider reference.")
    }
}

impl Spec {
    pub fn kind(&self) -> &'static str {
        match self {
            Spec::AltSales { .. } => "alt-sales",
            Spec::AltSupply { .. } => "alt-supply",
            Spec::AltSaleDetail { .. } => "alt-sale-detail",
            Spec::EbaySales(_) => "ebay-sales",
            Spec::EbaySupply(_) => "ebay-supply",
        }
    }

    /// Whether Alt answers it, rather than eBay.
    pub fn is_alt(&self) -> bool {
        matches!(
            self,
            Spec::AltSales { .. } | Spec::AltSupply { .. } | Spec::AltSaleDetail { .. }
        )
    }

    /// How long what is fetched stays fresh (`EVIDENCE_TTL_SECONDS`).
    pub fn ttl_seconds(&self) -> i64 {
        match self {
            Spec::AltSales { .. } | Spec::EbaySales(_) => 6 * 3600,
            Spec::AltSupply { .. } | Spec::EbaySupply(_) => 15 * 60,
            Spec::AltSaleDetail { .. } => 24 * 3600,
        }
    }

    /// `normalizeEvidenceSpec`: the request checked, its keywords' spaces collapsed.
    pub fn normalized(&self) -> Result<Spec, Refused> {
        Ok(match self {
            Spec::AltSales {
                asset_id,
                window,
                limit_per_grade,
            } => {
                if !(1..=16).contains(limit_per_grade) {
                    return refused("Alt sales are capped at sixteen observations per grade.");
                }
                Spec::AltSales {
                    asset_id: reference(asset_id)?,
                    window: window.checked()?,
                    limit_per_grade: *limit_per_grade,
                }
            }
            Spec::AltSupply { asset_id } => Spec::AltSupply {
                asset_id: reference(asset_id)?,
            },
            Spec::AltSaleDetail { transaction_id } => Spec::AltSaleDetail {
                transaction_id: reference(transaction_id)?,
            },
            Spec::EbaySales(page) => Spec::EbaySales(page.normalized()?),
            Spec::EbaySupply(page) => Spec::EbaySupply(page.normalized()?),
        })
    }

    /// `evidenceKey`: sha256 of the normalized request with the market it is read in.
    pub fn key(&self) -> Result<String, Refused> {
        #[derive(Serialize)]
        #[serde(untagged)]
        enum Context {
            Alt {
                market: &'static str,
                currency: &'static str,
            },
            Ebay {
                market: &'static str,
                currency: &'static str,
                category: &'static str,
            },
        }
        #[derive(Serialize)]
        struct Keyed<'a> {
            version: u8,
            context: Context,
            spec: &'a Spec,
        }
        let spec = self.normalized()?;
        let context = if spec.is_alt() {
            Context::Alt {
                market: "global",
                currency: "reported",
            }
        } else {
            Context::Ebay {
                market: "EBAY-US",
                currency: "USD",
                category: "0",
            }
        };
        let json = serde_json::to_string(&Keyed {
            version: 1,
            context,
            spec: &spec,
        })
        .expect("a request serializes");
        Ok(hex::encode(Sha256::digest(json.as_bytes())))
    }
}

impl EbayPage {
    fn normalized(&self) -> Result<EbayPage, Refused> {
        let bounded = self.group_key.len() == 64
            && self
                .group_key
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && !self.keywords.trim_matches(js_space).is_empty()
            && self.keywords.encode_utf16().count() <= 500
            && !self.keywords.chars().any(|c| (c as u32) < 0x20)
            && [10, 20, 50].contains(&self.limit)
            && (0..=10_000).contains(&self.offset)
            && self.offset % self.limit == 0
            && self.timezone.encode_utf16().count() <= 100;
        if !bounded {
            return refused("Provide a bounded eBay evidence request.");
        }
        if chrono_tz::Tz::from_str_insensitive(&self.timezone).is_err() {
            return refused("Choose a valid evidence timezone.");
        }
        let keywords = self
            .keywords
            .split(js_space)
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        Ok(EbayPage {
            group_key: self.group_key.clone(),
            keywords,
            window: self.window.checked()?,
            offset: self.offset,
            limit: self.limit,
            timezone: self.timezone.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn window() -> Window {
        Window {
            from: "2025-10-30".into(),
            to: "2026-10-30".into(),
        }
    }

    pub fn ebay(offset: i64) -> EbayPage {
        EbayPage {
            group_key: "ab".repeat(32),
            keywords: "  PSA 10\u{a0} Charizard   Base Set ".into(),
            window: window(),
            offset,
            limit: 50,
            timezone: "America/Chicago".into(),
        }
    }

    #[test]
    fn a_request_is_checked_as_node_checks_it() {
        let alt = |limit_per_grade| Spec::AltSales {
            asset_id: "asset-1".into(),
            window: window(),
            limit_per_grade,
        };
        assert!(alt(16).normalized().is_ok());
        assert_eq!(
            alt(17).normalized().unwrap_err().0,
            "Alt sales are capped at sixteen observations per grade."
        );
        let bad_id = Spec::AltSupply {
            asset_id: "a b".into(),
        };
        assert_eq!(
            bad_id.normalized().unwrap_err().0,
            "Provide a valid provider reference."
        );
        let mut tabbed = ebay(0);
        tabbed.keywords = "PSA\t10".into();
        assert_eq!(
            Spec::EbaySales(tabbed).normalized().unwrap_err().0,
            "Provide a bounded eBay evidence request."
        );
        let mut page = ebay(25);
        assert_eq!(
            Spec::EbaySales(page.clone()).normalized().unwrap_err().0,
            "Provide a bounded eBay evidence request."
        );
        page.offset = 50;
        page.timezone = "Mars/Olympus".into();
        assert_eq!(
            Spec::EbaySales(page).normalized().unwrap_err().0,
            "Choose a valid evidence timezone."
        );
        let backwards = Window {
            from: "2026-10-30".into(),
            to: "2026-10-29".into(),
        };
        assert_eq!(
            backwards.checked().unwrap_err().0,
            "Evidence window is out of range."
        );
        let impossible = Window {
            from: "2026-02-30".into(),
            to: "2026-03-01".into(),
        };
        assert_eq!(
            impossible.checked().unwrap_err().0,
            "Provide an explicit evidence date window."
        );
        match Spec::EbaySupply(ebay(0)).normalized().unwrap() {
            Spec::EbaySupply(page) => assert_eq!(page.keywords, "PSA 10 Charizard Base Set"),
            other => panic!("{other:?}"),
        }
    }

    /// Node: `evidenceKey` of the same requests (`.port-logs/slab-evidence-keys.ts`).
    #[test]
    fn keys_are_the_ones_node_computes() {
        let specs = [
            Spec::AltSales {
                asset_id: "asset-1".into(),
                window: window(),
                limit_per_grade: 16,
            },
            Spec::AltSupply {
                asset_id: "asset-1".into(),
            },
            Spec::AltSaleDetail {
                transaction_id: "tx-9".into(),
            },
            Spec::EbaySales(ebay(0)),
            Spec::EbaySupply(ebay(50)),
        ];
        let keys: Vec<String> = specs.iter().map(|s| s.key().unwrap()).collect();
        assert_eq!(keys, NODE_KEYS);
    }

    const NODE_KEYS: [&str; 5] = [
        "1f8bdc140506b2eec53c8347ad78f28482bde5a35d55ed1bad7a5281773e9957",
        "d8766db59c2816ff7e1eed58c48c0acc87683fc4e7573ae3739df2dc97ff3619",
        "8ce5f977db0afb96ed456e303a58c21b7bd56628ad156ba97bb51ef9cb01f610",
        "8426014778b1b22af95efeb8c25513310d201542378507245ddfc265e9d8de7b",
        "80428040d81e7763de3c2fa831f8ae899e011c5acab3218f6805e8863dcaddb1",
    ];
}
