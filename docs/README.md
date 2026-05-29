# Shareholder Resolution Signing — Documentation

This directory documents the shareholder resolution signing system built on top of the OpenSign fork.

## Contents

| File | Description |
|------|-------------|
| [overview.md](./overview.md) | What the system does, how it differs from standard OpenSign, and the end-to-end workflow |
| [threshold-model.md](./threshold-model.md) | Group A / Group B threshold definitions, weight assignment, and worked calculation example |
| [admin-guide.md](./admin-guide.md) | Step-by-step guide for admins: upload, configure, approve, monitor, and execute |
| [api-reference.md](./api-reference.md) | Parse Cloud Function reference: `initResolutionsSchema`, `importResolutionSchema`, `approveForSigning` |
| [ai-agent-guide.md](./ai-agent-guide.md) | Programmatic guide for scripts and AI agents using the Parse SDK |
| [field-types.md](./field-types.md) | Reference for all field types relevant to resolution documents |

## Quick links

- Backend cloud code: `apps/OpenSignServer/cloud/resolutions.js`
- Threshold config UI: `apps/OpenSign/src/components/pdf/ResolutionThresholdConfig.jsx`
- Progress widget: `apps/OpenSign/src/components/dashboard/ResolutionProgress.jsx`
- Frontend hook: `apps/OpenSign/src/hook/useResolutionThreshold.js`
