/**
 * The vendor modules the gateway knows (see types.ts for the contract). To
 * support another manufacturer: a folder next to `autel/`, one line here.
 */

import type { VendorModule } from './types.ts';
import { autel } from './autel/index.ts';

export const vendorModules: readonly VendorModule[] = [autel];
