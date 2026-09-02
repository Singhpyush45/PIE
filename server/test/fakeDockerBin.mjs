// Entry point for the test double. See fakeSandbox.mjs — it is not a sandbox.
import { main } from './fakeSandbox.mjs';
process.exit(main(process.argv.slice(2)));
