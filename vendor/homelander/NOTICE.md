# Homelander provenance

`url-translator.js` and `is24-contactor.js` originate from
https://github.com/B1Z0N/homelander at commit
`b0e7283b540d853311854d5111bffc0254d5ea85`, by Mykola Fedurko (B1Z0N).
The accompanying LICENSE preserves upstream's MIT license.

Local modifications:

- Strict URL validation rejects mobile-rejected filters, ignored equipment,
  unsupported heating, unknown property slugs, invalid origin/protocol,
  duplicate/empty filter parameters, ambiguous boolean flags and legacy
  equipment aliases. Strict mode removes upstream's extra swap-flat exclusion.
- The contactor requires a beforeSubmit approval hook immediately before its
  only submission command. onSubmitAttempt marks the uncertainty boundary
  before the browser command. Submission retries are removed entirely.
- Captcha solving is disabled; a challenge never causes an automatic resubmit.
  The caller must direct the user to solve it manually.

Live IS24 compatibility has not been tested. The adapter fails closed when page
structure, complete details, signed-in identity or exact form values cannot be
verified. This may require selector updates as the website changes.
