//! Compact list of relative paths: one big `String` and a list of offsets.
//! 500k paths of 60 bytes use about 30 MB for the text and 2 MB for offsets.
//! A `Vec<String>` would add 24 bytes of header and one allocation per path.

#[derive(Default, Clone)]
pub struct Store {
    buf: String,
    /// `offs[i]..offs[i + 1]` is path `i`. Always has `len + 1` items.
    offs: Vec<u32>,
}

impl Store {
    pub fn new() -> Self {
        Store { buf: String::new(), offs: vec![0] }
    }

    pub fn with_capacity(paths: usize, bytes: usize) -> Self {
        let mut offs = Vec::with_capacity(paths + 1);
        offs.push(0);
        Store { buf: String::with_capacity(bytes), offs }
    }

    pub fn len(&self) -> usize {
        self.offs.len().saturating_sub(1)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn bytes(&self) -> usize {
        self.buf.len()
    }

    pub fn get(&self, i: usize) -> &str {
        &self.buf[self.offs[i] as usize..self.offs[i + 1] as usize]
    }

    /// Returns false when the 4 GB offset limit is reached.
    pub fn push(&mut self, path: &str) -> bool {
        if self.buf.len() + path.len() >= u32::MAX as usize {
            return false;
        }
        self.buf.push_str(path);
        self.offs.push(self.buf.len() as u32);
        true
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        (0..self.len()).map(|i| self.get(i))
    }

    /// Builds a store from paths that are already sorted.
    pub fn from_sorted<'a>(paths: impl ExactSizeIterator<Item = &'a str>) -> Self {
        let mut s = Store::with_capacity(paths.len(), 0);
        for p in paths {
            s.push(p);
        }
        s
    }

    /// First index whose path is not smaller than `key`. The store must be sorted.
    pub fn lower_bound(&self, key: &str) -> usize {
        let (mut lo, mut hi) = (0, self.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.get(mid) < key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// True when some path starts with `prefix`. The store must be sorted.
    pub fn has_prefix(&self, prefix: &str) -> bool {
        let i = self.lower_bound(prefix);
        i < self.len() && self.get(i).starts_with(prefix)
    }
}
