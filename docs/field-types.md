# Field Types

Fields are boxes placed on PDF pages in the drag-and-drop editor. Each field is associated with a specific signer. When that signer opens the document, they see and interact with their assigned fields.

Field positions are stored in `contracts_Document.Placeholders` under the `placeHolder` array for each signer, grouped by page number.

---

## `signature`

A drawn or typed signature.

| Property | Details |
|----------|---------|
| Filled by | Signer at signing time |
| Input method | Draw (canvas), type (font-rendered), or upload an image |
| Auto-filled | No — requires explicit signer action |
| Stored as | Base64 image embedded into the PDF |

The signature field is required for execution in all standard resolution configurations. One signature field per signer is typical; additional signature fields (e.g., on multiple pages) are also supported.

---

## `name`

The signer's full name.

| Property | Details |
|----------|---------|
| Filled by | Auto-filled from the signer's profile (`contracts_Contactbook.Name`) |
| Input method | None — read-only at signing time |
| Auto-filled | Yes |

---

## `job title`

The signer's job title or role.

| Property | Details |
|----------|---------|
| Filled by | Auto-filled from the signer's profile |
| Input method | None — read-only at signing time |
| Auto-filled | Yes |

---

## `date`

The date on which the signer signed the document.

| Property | Details |
|----------|---------|
| Filled by | Auto-filled at the moment of signing |
| Input method | None — inserted by the system |
| Auto-filled | Yes, set to the signing timestamp formatted per the tenant's date format preference |

---

## `weight factor` (new)

A labelled text input that the signer fills in manually. Used to capture a numeric value associated with the signer — typically shares held, voting units, or any other quantity that provides transparency alongside the configured weights.

| Property | Details |
|----------|---------|
| Filled by | Signer at signing time |
| Input method | Free text input field |
| Auto-filled | No |
| Label | Set by the admin when placing the field (e.g., "Shares Held", "Voting Units") |

**Important**: The value entered by the signer in this field is for transparency and record-keeping only. It is displayed on the signed document. The actual weights used for threshold calculations come from the `resolutions_SignerWeight` records configured by the admin via `importResolutionSchema` — not from what the signer types here.

### Placement

In the drag-and-drop editor, `weight factor` behaves like a text input widget. Set the `label` property to a descriptive string (e.g., `"Shares Held"`). The label is shown above the input box on the signing page.

### In `importResolutionSchema`

```json
{
  "signerEmail": "alice@example.com",
  "type": "weight factor",
  "label": "Shares Held",
  "page": 2,
  "x": 0.40,
  "y": 0.78,
  "width": 0.15,
  "height": 0.04
}
```

### Technical note

In `PlaceHolderSign.jsx`, `"weight factor"` is handled in the same branch as other text input widget types (`textInputWidget`, `textWidget`, `"name"`, `"company"`, `"job title"`, `"email"`). It receives font size and color defaults, and its response value is stored in `options.response` within the Placeholder position object.

---

## Other field types (standard OpenSign)

The following field types are available in standard OpenSign and can be used in resolution documents where appropriate:

| Type | Description |
|------|-------------|
| `initials` | Signer's initials (drawn, typed, or default) |
| `email` | Auto-filled with the signer's email address |
| `company` | Auto-filled with the signer's company name |
| `text` | Free-form text input with no special semantics |
| `checkbox` | Checkbox — signer checks or leaves unchecked |
| `radio` | Radio button group |
| `dropdown` | Dropdown selection from a predefined list |
| `image` | Image upload field |
| `stamp` | Stamp / seal image |

These types are documented in the main OpenSign project. The resolution signing system does not modify their behaviour.
