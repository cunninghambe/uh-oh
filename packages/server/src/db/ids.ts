import { randomBytes, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

export const newPublicKey = (): string => randomBytes(32).toString('hex');
