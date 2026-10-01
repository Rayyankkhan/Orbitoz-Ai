import { Injectable } from '@nestjs/common';
import { loadEnv, type Env } from './env.js';

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
}
