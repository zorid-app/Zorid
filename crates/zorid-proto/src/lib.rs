//! Generated wire data only. Decoding grants no authentication, durability,
//! ownership or verification capability. Consumers bound input before decoding
//! and validate domain semantics before converting these public message fields.
#![no_std]

pub use prost::Message;
pub mod zorid {
    pub mod common {
        pub mod v1 {
            include!("generated/zorid.common.v1.rs");
        }
    }
    pub mod sync {
        pub mod rpc {
            pub mod v1 {
                include!("generated/zorid.sync.rpc.v1.rs");
            }
        }
    }
    pub mod stream {
        pub mod v1 {
            include!("generated/zorid.stream.v1.rs");
        }
    }
}
