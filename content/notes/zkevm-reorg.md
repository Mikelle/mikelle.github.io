---
title: "zkEVM reorg handling is brutal"
date: 2024-12-15
draft: true
tags: ["zkEVM", "sequencer"]
---

Underrated complexity. When L1 reorgs, the sequencer needs to unwind state, reprocess transactions, handle stuck batches. Edge cases everywhere.

Spent a week debugging a reorg edge case where the prover had already started on a batch that got invalidated. Fun times.
