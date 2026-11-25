//! The recent measurements of one series (a device, or one of its log types), held small.
//!
//! A cluster of 25 000 devices holds 9 million of these at the two-hourly schedule (31 days), and
//! 7 million more for three log types a device (8 days). As `Vec<Point>` one is 32 bytes; here it
//! is 12, in chunks shared between copies of a tracker: a run works on a copy while the pages read
//! the old one, and only the newest few points of it are doubled.
//!
//! In a tracker file a device's points are `[t, m, s]` tuples, as before 0.3.90; a log type's are
//! one text (`compact`), about a third of that.

use super::levels::State;
use super::state::Point;
use serde::de::{Deserialize, Deserializer, Error as _, SeqAccess, Visitor};
use serde::ser::{Serialize, Serializer};
use std::sync::Arc;

/// Points in one shared chunk.
const CHUNK: usize = 24;

/// `t` (epoch ms) in 48 bits, `m` in hundredths of a minute in 40 (the smallest: no figure), `s`.
/// `m` is kept to two decimals, as it is measured (`measure::round2`).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Packed([u8; 12]);

const NONE_M: i64 = -(1 << 39);

impl From<Point> for Packed {
    fn from(p: Point) -> Packed {
        let t = p.t.clamp(0, (1 << 48) - 1) as u64;
        let m = match p.m {
            Some(m) if m.is_finite() => ((m * 100.0).round() as i64).clamp(NONE_M + 1, (1 << 39) - 1),
            _ => NONE_M,
        };
        let mut b = [0u8; 12];
        b[..6].copy_from_slice(&t.to_le_bytes()[..6]);
        b[6..11].copy_from_slice(&m.to_le_bytes()[..5]);
        b[11] = p.s.code();
        Packed(b)
    }
}

impl From<Packed> for Point {
    fn from(p: Packed) -> Point {
        let mut t = [0u8; 8];
        t[..6].copy_from_slice(&p.0[..6]);
        let sign = if p.0[10] & 0x80 != 0 { 0xff } else { 0 };
        let mut m = [sign; 8];
        m[..5].copy_from_slice(&p.0[6..11]);
        let m = i64::from_le_bytes(m);
        Point { t: i64::from_le_bytes(t), m: (m != NONE_M).then_some(m as f64 / 100.0), s: State::of_code(p.0[11]) }
    }
}

/// Points, oldest first.
#[derive(Clone, Debug, Default)]
pub struct Points {
    full: Vec<Arc<[Packed]>>,
    tail: Vec<Packed>,
    /// Points of the first chunk that are past their keeping.
    skip: u32,
    compact: bool,
}

impl Points {
    /// Written as one text: a log type's.
    pub fn compact() -> Points {
        Points { compact: true, ..Points::default() }
    }

    pub fn push(&mut self, p: Point) {
        if self.tail.len() == self.tail.capacity() {
            // A few at a time: most series keep the same length for weeks.
            self.tail.reserve_exact(4);
        }
        self.tail.push(p.into());
        if self.tail.len() >= CHUNK {
            self.full.push(Arc::from(std::mem::take(&mut self.tail)));
        }
    }

    pub fn iter(&self) -> impl DoubleEndedIterator<Item = Point> + Clone + '_ {
        let skip = self.skip as usize;
        self.full.iter().enumerate().flat_map(move |(i, c)| c[if i == 0 { skip } else { 0 }..].iter()).chain(self.tail.iter()).map(|p| Point::from(*p))
    }

    pub fn len(&self) -> usize {
        self.full.iter().map(|c| c.len()).sum::<usize>() - self.skip as usize + self.tail.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Points newer than `t` only.
    pub fn keep_after(&mut self, t: i64) {
        while let Some(first) = self.full.first() {
            let gone = first[self.skip as usize..].iter().take_while(|p| Point::from(**p).t <= t).count();
            self.skip += gone as u32;
            if (self.skip as usize) < first.len() {
                return;
            }
            self.full.remove(0);
            self.skip = 0;
        }
        self.tail.retain(|p| Point::from(*p).t > t);
    }

    fn text(&self) -> String {
        use std::fmt::Write as _;
        let mut s = String::with_capacity(self.len() * 14);
        let mut before = 0i64;
        for p in self.iter() {
            let _ = match p.m {
                Some(m) => write!(s, "{}{}:{m}{}", if s.is_empty() { "" } else { " " }, p.t - before, p.s.letter()),
                None => write!(s, "{}{}:{}", if s.is_empty() { "" } else { " " }, p.t - before, p.s.letter()),
            };
            before = p.t;
        }
        s
    }

    fn of_text(s: &str) -> Option<Points> {
        let mut out = Points::compact();
        let mut before = 0i64;
        for w in s.split_ascii_whitespace() {
            let (dt, rest) = w.split_once(':')?;
            let letter = rest.chars().last()?;
            let m = &rest[..rest.len() - letter.len_utf8()];
            before += dt.parse::<i64>().ok()?;
            out.push(Point { t: before, m: if m.is_empty() { None } else { Some(m.parse().ok()?) }, s: State::of_letter(letter)? });
        }
        Some(out)
    }
}

impl PartialEq for Points {
    fn eq(&self, o: &Points) -> bool {
        self.len() == o.len() && self.iter().eq(o.iter())
    }
}

impl FromIterator<Point> for Points {
    fn from_iter<I: IntoIterator<Item = Point>>(it: I) -> Points {
        let mut out = Points::default();
        it.into_iter().for_each(|p| out.push(p));
        out
    }
}

impl Serialize for Points {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if self.compact { s.serialize_str(&self.text()) } else { s.collect_seq(self.iter()) }
    }
}

impl<'de> Deserialize<'de> for Points {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Points, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Points;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a list of points, or their text")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Points, E> {
                Points::of_text(v).ok_or_else(|| E::custom("a text of points that cannot be read"))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Points, A::Error> {
                let mut out = Points::default();
                while let Some(p) = a.next_element::<Point>()? {
                    out.push(p);
                }
                Ok(out)
            }
        }
        d.deserialize_any(V).map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(t: i64, m: Option<f64>, s: State) -> Point {
        Point { t, m, s }
    }

    #[test]
    fn a_point_comes_back_as_it_was_whatever_its_size() {
        for x in [p(0, Some(0.0), State::NoDelay), p(1_763_100_000_123, Some(46.25), State::Delay), p(1_763_100_000_123, Some(-327.22), State::ClockAhead),
                  p(5, None, State::Silent), p(5, None, State::Unmeasured), p(1, Some(29_400_000.07), State::Critical), p(1, Some(46.0), State::PartDelay)] {
            assert_eq!(Point::from(Packed::from(x)), x, "{x:?}");
        }
        assert_eq!(std::mem::size_of::<Packed>(), 12);
        for s in State::ALL {
            assert_eq!((State::of_code(s.code()), State::of_letter(s.letter())), (s, Some(s)));
        }
    }

    #[test]
    fn both_files_forms_read_and_old_points_go_by_age() {
        let many: Points = (0..100).map(|i| p(1_763_100_000_000 + i * 7_200_013, if i % 7 == 0 { None } else { Some(i as f64 / 4.0) }, if i % 7 == 0 { State::Silent } else { State::NoDelay })).collect();
        let s = serde_json::to_string(&many).unwrap();
        assert!(s.starts_with("[[1763100000000,null,\"silent\"],[1763107200013,0.25,\"no_delay\"]"), "{s}");
        assert_eq!(serde_json::from_str::<Points>(&s).unwrap(), many);
        let mut small = Points::compact();
        many.iter().for_each(|x| small.push(x));
        let t = serde_json::to_string(&small).unwrap();
        assert!(t.starts_with("\"1763100000000:s 7200013:0.25n ") && t.len() * 2 < s.len(), "{t}");
        let back: Points = serde_json::from_str(&t).unwrap();
        assert!(back.compact && back == many);
        assert_eq!(serde_json::from_str::<Points>("[{\"t\":5,\"s\":\"silent\"}]").unwrap().iter().collect::<Vec<_>>(), vec![p(5, None, State::Silent)]);
        assert!(serde_json::from_str::<Points>("\"nonsense\"").is_err());
        let mut k = many.clone();
        let cut = 1_763_100_000_000 + 60 * 7_200_013;
        k.keep_after(cut);
        assert_eq!((k.len(), k.iter().next().unwrap().t, k.iter().next_back().unwrap().t), (39, cut + 7_200_013, 1_763_100_000_000 + 99 * 7_200_013));
        assert_eq!(k.iter().rev().count(), 39);
        k.keep_after(i64::MAX);
        assert!(k.is_empty() && many.len() == 100, "a copy's chunks are its own to drop");
    }
}
