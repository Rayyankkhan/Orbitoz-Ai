import { Injectable } from '@nestjs/common';
import { loadEnv, type Env } from './env.js';
import type { ScryptCost } from '../auth/password.js';

/** Injectable wrapper so the rest of the app never touches `process.env`. */
@Injectable()
export class EnvService {
  readonly value: Env = loadEnv();

  get tenantHeader(): string {
    return this.value.tenancy.header;
  }

  get tenantRequired(): boolean {
    return this.value.tenancy.required;
  }

  get accessTtlSeconds(): number {
    return this.value.auth.accessTtlSeconds;
  }

  get refreshTtlSeconds(): number {
    return this.value.auth.refreshTtlSeconds;
  }

  /**
   * scrypt cost for newly created password hashes.
   *
   * Overridable per environment, because the right value depends on the hardware
   * the gateway actually runs on. The parameters are stored inside each hash, so
   * raising this never invalidates existing credentials — they are upgraded
   * opportunistically at the next successful sign-in.
   */
  get scryptCost(): ScryptCost {
    return this.value.auth.scryptCost;
  }
}
