// design §7.2 H3: this project's one vitest `setupFiles` entry. Every test file's console is captured and
// scanned in afterAll; suites register their secrets with guardOutput().
import { installFileGuard } from "./h3";

installFileGuard();
