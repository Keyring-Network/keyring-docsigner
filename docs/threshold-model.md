# Threshold Model

## Group definitions

### Group A — Total weighted majority

Group A measures signed weight as a fraction of the **total weight across all signers**.

```
ratioA = sum(weightGroupA for signers who have signed)
       / sum(weightGroupA for all signers)
```

Group A passes when `ratioA > thresholdA`.

This threshold represents the standard majority requirement: enough aggregate voting power has approved the resolution.

### Group B — Independent weighted majority

Group B measures signed weight as a fraction of the **total weight of signers not excluded from Group B**.

```
ratioB = sum(weightGroupB for non-excluded signers who have signed)
       / sum(weightGroupB for all non-excluded signers)
```

Group B passes when `ratioB > thresholdB`.

A single signer can be flagged `excludedFromB = true`. That signer's weight does not appear in either the numerator or denominator of the Group B calculation, regardless of whether they have signed. Their Group A weight is unaffected.

### Execution condition

Both thresholds must be met simultaneously:

```
execute if (ratioA > thresholdA) AND (ratioB > thresholdB)
```

The check runs after every signing event. Execution triggers the first time the condition becomes true.

## Why two groups

Corporate governance for shareholder resolutions commonly imposes two distinct approval requirements:

1. **Aggregate majority**: Shareholders representing more than 75% of total voting shares must approve. This prevents a minority from blocking a near-unanimous decision.

2. **Independent majority**: A subset of shareholders — those who are not the dominant controlling party — must also approve, measured against their own collective weight. This prevents a single majority shareholder from self-approving decisions that affect other shareholders.

The exclusion mechanism (Group B) supports the second requirement without modifying the document or signer list structure: the controlling shareholder still signs and contributes to Group A; they simply do not count toward the Group B quorum.

Both threshold percentages and the choice of excluded signer are configured per-document by the admin.

## Weight assignment

Weights represent the signing party's proportion of vote. They are stored as raw numeric values, not normalized fractions. The threshold check divides signed weight by total weight, so the absolute scale does not matter — only the ratios between signers.

Typical assignment patterns:

- **Proportional to shares held**: `weightGroupA = shares / totalShares`. The `weight factor` field on the document lets the signer self-report their share count for transparency, but the authoritative weight used for the calculation comes from the `resolutions_SignerWeight` records set by the admin.
- **Equal weights**: All signers get `weightGroupA = 1`. Useful when the governance rule is "a majority of named parties", not share-weighted.
- **Custom weights**: Any non-negative numeric values are accepted.

A signer excluded from Group B should have `weightGroupB = 0` (or any value — it is ignored) and `excludedFromB = true`.

## How `checkThresholds()` works

```
function checkThresholds(documentId):

  1. Fetch resolutions_Threshold where document = documentId
     - If none found: return null (not a resolution document)
     - If status != 'ACTIVE': return null (not yet approved or already executed)

  2. Fetch all resolutions_SignerWeight records for documentId

  3. Fetch contracts_Document, read AuditTrail
     - Collect emails of signers whose AuditTrail entry has Activity in ['Signed', 'Approved']

  4. For each resolutions_SignerWeight record:
       totalA += weightGroupA
       if signer has signed: signedA += weightGroupA

       if NOT excludedFromB:
         totalB += weightGroupB
         if signer has signed: signedB += weightGroupB

  5. ratioA = signedA / totalA  (0 if totalA == 0)
     ratioB = signedB / totalB  (0 if totalB == 0)

  6. return (ratioA > thresholdA) AND (ratioB > thresholdB)
```

The function returns `true` (thresholds met), `false` (not met), or `null` (document has no active threshold record).

## Worked example

**Setup:**

| Signer | weightGroupA | weightGroupB | excludedFromB |
|--------|-------------|-------------|---------------|
| Alice  | 0.35        | 0.45        | false         |
| Bob    | 0.40        | 0.55        | false         |
| Carol  | 0.25        | 0.00        | true          |

Thresholds: `thresholdA = 0.75`, `thresholdB = 0.50`

**After Alice signs:**

Group A:
- `totalA = 0.35 + 0.40 + 0.25 = 1.00`
- `signedA = 0.35`
- `ratioA = 0.35 / 1.00 = 0.35` — below 0.75, not met

Group B (Carol excluded):
- `totalB = 0.45 + 0.55 = 1.00`
- `signedB = 0.45`
- `ratioB = 0.45 / 1.00 = 0.45` — below 0.50, not met

Result: `false`. No execution.

**After Bob signs (Alice and Bob have both signed):**

Group A:
- `signedA = 0.35 + 0.40 = 0.75`
- `ratioA = 0.75 / 1.00 = 0.75` — exceeds 0.75, passed

Group B:
- `signedB = 0.45 + 0.55 = 1.00`
- `ratioB = 1.00 / 1.00 = 1.00` — exceeds 0.50, passed

Result: `true`. `executeDocument()` is called.

Note: Carol has not signed. Because Carol is excluded from Group B, her absence does not affect the Group B calculation. Carol's Group A weight of 0.25 did not contribute to `signedA`, but her inclusion in `totalA` required Alice and Bob together to reach exactly 0.75 — the minimum required.

**Boundary-case caveat:** `ratioA = 0.75` and `thresholdA = 0.75`. The implementation uses strict `>` so this exact value would NOT trigger execution. To trigger execution with these weights, Alice, Bob, and Carol must all sign (ratioA = 1.00), or weights must be chosen so the signed ratio strictly exceeds the threshold.
