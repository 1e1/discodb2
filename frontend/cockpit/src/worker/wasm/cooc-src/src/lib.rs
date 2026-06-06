// discodb2 — co-occurrence TALLY kernel (WASM), DESIGN §6.1.4 step 4 / §6.1.5.
//
// The single hottest vectorizable kernel selected by the Phase 0 bench: the
// O(pairs · bytes²) consecutive-pair change tally that dominates a whole-buffer
// co-occurrence scan (and scales linearly with input → the batch-regime win).
//
// This is a DROP-IN ACCELERATOR for the pure-JS `profileOneIdPacked` tally in
// `frontend/shared/analysis/co-occurrence.ts`; it computes the IDENTICAL integer
// counts (changed / present / coChange / coPresent), so the JS derivation
// (jaccard, conditional, groups, hubs) runs unchanged on top of it. Pure integer
// ⇒ scalar AND SIMD are BIT-IDENTICAL to JS (integer adds don't reorder-drift).
//
// No wasm-bindgen, no_std, plain `extern "C"` over a shared WebAssembly.Memory.
// The ONLY difference between the scalar and simd128 builds is `change_mask`
// (one v128 byte-compare vs a scalar byte loop) — both yield the same mask, so
// the two .wasm tiers produce identical output. Build: see README.md.

#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    // no_std, panic=abort: a trap is the right failure mode in the worker.
    core::arch::wasm32::unreachable()
}

/// Per consecutive pair, the bitmask of payload bytes that CHANGED (bit b set iff
/// `data[a+b] != data[c+b]`), for b in 0..common. Bits ≥ `common` are cleared.
///
/// SIMD tier: one `u8x16_ne` of the two 8-byte payloads (loaded as 16 bytes — the
/// packed buffer guarantees ≥16 bytes of slack past the last frame, and only the
/// low `common` ≤ 8 lanes are ever used) → `u8x16_bitmask`, masked to `common`.
#[cfg(target_feature = "simd128")]
#[inline]
unsafe fn change_mask(data: *const u8, a: usize, c: usize, common: usize) -> u32 {
    use core::arch::wasm32::*;
    let pv = v128_load(data.add(a) as *const v128);
    let cv = v128_load(data.add(c) as *const v128);
    let neq = u8x16_ne(pv, cv); // 0xFF per lane where bytes differ
    let mask = u8x16_bitmask(neq) as u32; // bit b = lane b differs
    let keep = if common >= 32 { u32::MAX } else { (1u32 << common) - 1 };
    mask & keep
}

/// Scalar tier: the plain byte loop. Identical result to the SIMD path.
#[cfg(not(target_feature = "simd128"))]
#[inline]
unsafe fn change_mask(data: *const u8, a: usize, c: usize, common: usize) -> u32 {
    let mut mask = 0u32;
    let mut b = 0usize;
    while b < common {
        if *data.add(a + b) != *data.add(c + b) {
            mask |= 1u32 << b;
        }
        b += 1;
    }
    mask
}

/// Tally the co-change matrices for ONE id's frames (index list `indices`, in
/// arrival order). Mirrors `profileOneIdPacked`'s inner loop exactly:
///   • `present[i]`         += 1 for every pair where byte i is carried by both
///   • `changed[i]`         += 1 when byte i additionally differs
///   • `co_present[i*bc+j]` (and j*bc+i) += 1 when both i,j carried by both
///   • `co_change[i*bc+j]`  (and j*bc+i) += 1 when both i,j changed
/// where `bc = byte_count` is the matrix stride. A pair contributes to byte i /
/// pair (i,j) only within `common = min(dlc[prev], dlc[cur], byte_count)`
/// (short-DLC handling). Outputs MUST be zeroed by the caller.
///
/// # Safety
/// All pointers must reference at least: `data` ≥ max(indices)*8 + 16 bytes,
/// `dlc` ≥ max(indices)+1 bytes, `indices` ≥ n i32s, and each output ≥ its size
/// (`changed`/`present`: bc i32s; `co_change`/`co_present`: bc*bc i32s).
#[no_mangle]
pub unsafe extern "C" fn cooc_tally(
    data: *const u8,
    dlc: *const u8,
    indices: *const i32,
    n: i32,
    byte_count: i32,
    changed: *mut i32,
    present: *mut i32,
    co_change: *mut i32,
    co_present: *mut i32,
) {
    let n = n as usize;
    let bc = byte_count as usize;
    if n < 2 || bc == 0 {
        return;
    }

    let mut prev = *indices.add(0) as usize;
    let mut k = 1usize;
    while k < n {
        let cur = *indices.add(k) as usize;
        let lp = *dlc.add(prev) as usize;
        let lc = *dlc.add(cur) as usize;
        // common = min(lp, lc, bc)
        let mut common = if lp < lc { lp } else { lc };
        if bc < common {
            common = bc;
        }

        let pbase = prev * 8;
        let cbase = cur * 8;
        let mask = change_mask(data, pbase, cbase, common);

        // Marginals.
        let mut i = 0usize;
        while i < common {
            *present.add(i) += 1;
            if (mask >> i) & 1 == 1 {
                *changed.add(i) += 1;
            }
            i += 1;
        }

        // Pairwise (upper triangle, mirrored) — same order as the JS reference.
        i = 0;
        while i < common {
            let ci = (mask >> i) & 1;
            let row = i * bc;
            let mut j = i + 1;
            while j < common {
                *co_present.add(row + j) += 1;
                *co_present.add(j * bc + i) += 1;
                if ci == 1 && (mask >> j) & 1 == 1 {
                    *co_change.add(row + j) += 1;
                    *co_change.add(j * bc + i) += 1;
                }
                j += 1;
            }
            i += 1;
        }

        prev = cur;
        k += 1;
    }
}
