# Homelander provenance

`url-translator.js` and `is24-contactor.js` originate from
https://github.com/B1Z0N/homelander at commit
`b0e7283b540d853311854d5111bffc0254d5ea85`, by Mykola Fedurko (B1Z0N).
The upstream MIT license is reproduced below.

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

## MIT license

MIT License

Copyright (c) 2026 Mykola Fedurko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Codex CLI

The image bundles unmodified `@openai/codex` 0.162.1 from
https://github.com/openai/codex, licensed under Apache-2.0.
Its license and upstream notice are preserved in `licenses/codex-APACHE-2.0.txt`
and `licenses/codex-NOTICE.txt`; package-provided third-party notices remain
within `node_modules/@openai/`.
