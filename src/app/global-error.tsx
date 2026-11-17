"use client";

import { storefrontPath } from "@/config/storefront-path";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return <html lang="en"><body>
    <main>
      <h1>This storefront is temporarily unavailable</h1>
      <p>Try again to reopen the same storefront.</p>
      <button type="button" onClick={reset}>Try again</button>
      <p><a href={storefrontPath("/global-account")}>Choose a storefront</a></p>
    </main>
  </body></html>;
}
