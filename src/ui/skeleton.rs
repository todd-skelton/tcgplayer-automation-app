// corten ui 0.1.0: skeleton 005b37a375715323
//! A placeholder's shape while a part loads (a `<corten-live>` region before its first value):
//! `<Skeleton shape={SkeletonShape::Line} />`. It is hidden from screen readers; say what is
//! loading in text (`aria-busy` on the region).
use corten::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkeletonShape {
    Line,
    Block,
    Circle,
}

/// A shape without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Skeleton() -> impl Render {
///     html! { <span class={(Skeleton, Star)}></span> }
/// }
/// ```
#[component(css)]
pub fn Skeleton(shape: SkeletonShape) -> impl Render {
    let shape = match shape {
        SkeletonShape::Line => Line,
        SkeletonShape::Block => Block,
        SkeletonShape::Circle => Circle,
    };
    html! { <span class={(Skeleton, shape)} aria-hidden="true"></span> }
}
