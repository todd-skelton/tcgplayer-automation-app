//! `Math.exp` and `Math.log` as V8 computes them (fdlibm), so a figure the Node app derived
//! reads back to the same bits here: a plan's snapshot hash is taken over such figures. The
//! platform's own `exp` and `ln` differ from V8 in the last bit for about one value in ten
//! and one in fifty.

/// Math functions with JavaScript's results.
pub trait JsMath {
    /// `Math.exp`: fdlibm's, as musl and the `libm` crate carry it.
    fn js_exp(self) -> f64;
    /// `Math.log`.
    fn js_ln(self) -> f64;
}

impl JsMath for f64 {
    fn js_exp(self) -> f64 {
        libm::exp(self)
    }

    fn js_ln(self) -> f64 {
        log(self)
    }
}

/// fdlibm's `__ieee754_log` (FreeBSD e_log.c), which V8's `Math.log` is.
pub fn log(x: f64) -> f64 {
    const LN2_HI: f64 = f64::from_bits(0x3fe62e42fee00000);
    const LN2_LO: f64 = f64::from_bits(0x3dea39ef35793c76);
    const TWO54: f64 = f64::from_bits(0x4350000000000000);
    const LG1: f64 = f64::from_bits(0x3fe5555555555593);
    const LG2: f64 = f64::from_bits(0x3fd999999997fa04);
    const LG3: f64 = f64::from_bits(0x3fd2492494229359);
    const LG4: f64 = f64::from_bits(0x3fcc71c51d8e78af);
    const LG5: f64 = f64::from_bits(0x3fc7466496cb03de);
    const LG6: f64 = f64::from_bits(0x3fc39a09d078c69f);
    const LG7: f64 = f64::from_bits(0x3fc2f112df3e5244);
    let mut x = x;
    let bits = x.to_bits();
    let mut hx = (bits >> 32) as i32;
    let lx = bits as u32;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = (x.to_bits() >> 32) as i32;
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    x = f64::from_bits(
        (((hx | (i ^ 0x3ff0_0000)) as u32 as u64) << 32) | (x.to_bits() & 0xffff_ffff),
    );
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - (1.0 / 3.0) * f);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_v8_where_the_platform_differs() {
        // V8's answers (Node 22) where the platform's `ln` and `exp` miss by one bit.
        assert_eq!(23.35705794991507f64.js_ln(), 3.1508992061035554);
        assert_eq!(175.63677958048925f64.js_ln(), 5.168418110183184);
        assert_eq!(2.5704042991579357f64.js_ln(), 0.9440632013818913);
        assert_eq!(15.603969550274295f64.js_exp(), 5980229.782012517);
        assert_eq!(0.601219311541219f64.js_exp(), 1.82434188591479);
        assert_eq!(13.468840292252388f64.js_exp(), 707038.42463732);
        assert_eq!(1.0f64.js_ln(), 0.0);
        assert_eq!(2.0f64.js_ln(), std::f64::consts::LN_2);
        assert_eq!(0.0f64.js_ln(), f64::NEG_INFINITY);
        assert!((-1.0f64).js_ln().is_nan());
        assert_eq!(0.0f64.js_exp(), 1.0);
    }
}
