/**
 * Typed submit intent for standalone create forms that offer both ordinary Save
 * and Save & new (issue #287). Enter / native form submission use the default
 * `save` meta; Save & new passes `save_and_new` explicitly via handleSubmit.
 * Intent is never inferred from button text or DOM position.
 */
export type CreateFormSubmitIntent = "save" | "save_and_new";

export type CreateFormSubmitMeta = {
  intent: CreateFormSubmitIntent;
};

/** Default meta when handleSubmit is called without arguments (Enter / Save). */
export const defaultCreateSubmitMeta: CreateFormSubmitMeta = {
  intent: "save",
};
