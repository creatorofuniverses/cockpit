//! The aq space for the Herdr app: the heavy commands agents run through aq (a local queue that starts them when memory
//! is free), read from the dashboard snapshot aq's daemon keeps, with cancel, extend, release and the logs.

pub mod gui;
pub mod model;
