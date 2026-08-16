/**
 * Nominal typing helper.
 *
 * Plain `string` identifiers are interchangeable, which is how a media key ends
 * up where an invitation id belongs. Branding makes those mistakes type errors
 * without any runtime cost.
 */
declare const brand: unique symbol;

export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type UserId = Brand<string, 'UserId'>;
export type InvitationId = Brand<string, 'InvitationId'>;
export type TemplateId = Brand<string, 'TemplateId'>;
export type MediaId = Brand<string, 'MediaId'>;
export type RsvpId = Brand<string, 'RsvpId'>;
export type SessionId = Brand<string, 'SessionId'>;

/** Storage keys are constructed server-side only — never from client input. */
export type StorageKey = Brand<string, 'StorageKey'>;
