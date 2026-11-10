// design §7.2 H3: the one vitest `setupFiles` entry of every project that can import testkit. Each test
// file gets a console capture scanned in afterAll; suites register their secrets with guardOutput() or
// noteSecret(). The FakeKeyring default secret is always scanned for.
import { installFileGuard } from "./outputGuard";

installFileGuard({ name: "default fake secret", value: "fake-secret" });
