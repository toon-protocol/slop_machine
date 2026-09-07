/**
 * Minimal types for `playwright/test`, declared here because Playwright is a
 * GLOBAL on the box — installed through `mise`, never a dependency of this
 * repository — so the module has no types in `node_modules` for `tsc` to
 * find. The `playwright test` CLI resolves the real implementation from its
 * own installation when it runs a spec; this file only keeps the specs
 * typechecked by `pnpm typecheck` alongside the rest of the guide.
 *
 * Deliberately narrow: it declares exactly the surface the specs and the
 * config use, so drifting from real Playwright shows up as a compile error
 * in a spec rather than as a silently-wrong shim.
 */
declare module 'playwright/test' {
  export interface Locator {
    filter(options: { hasText?: string | RegExp }): Locator;
    first(): Locator;
    getByTestId(testId: string): Locator;
    click(options?: { timeout?: number }): Promise<void>;
    evaluate<Result>(body: (element: Element) => Result): Promise<Result>;
  }

  export interface Page {
    goto(url: string): Promise<unknown>;
    getByTestId(testId: string): Locator;
    getByRole(role: string, options?: { name?: string | RegExp }): Locator;
    getByText(text: string | RegExp): Locator;
    locator(selector: string): Locator;
  }

  export interface LocatorExpectations {
    toBeVisible(options?: { timeout?: number }): Promise<void>;
    toContainText(
      expected: string | RegExp,
      options?: { timeout?: number }
    ): Promise<void>;
    toHaveCount(
      expected: number,
      options?: { timeout?: number }
    ): Promise<void>;
    toHaveText(
      expected: string | RegExp,
      options?: { timeout?: number }
    ): Promise<void>;
  }

  export interface PageExpectations {
    toHaveURL(
      expected: string | RegExp,
      options?: { timeout?: number }
    ): Promise<void>;
  }

  export interface PollExpectations {
    toBeGreaterThan(expected: number): Promise<void>;
  }

  export const test: {
    (name: string, body: (fixtures: { page: Page }) => Promise<void>): void;
    beforeAll(body: () => Promise<void>): void;
    describe(name: string, body: () => void): void;
    setTimeout(milliseconds: number): void;
  };

  export const expect: {
    (subject: Locator): LocatorExpectations;
    (subject: Page): PageExpectations;
    poll(
      subject: () => Promise<number>,
      options?: { timeout?: number }
    ): PollExpectations;
  };

  export function defineConfig<Config>(config: Config): Config;
}
