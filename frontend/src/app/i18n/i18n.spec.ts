import el from '../../assets/i18n/el.json';
import en from '../../assets/i18n/en.json';
import { AppLanguage } from './language.service';
import { lookupTranslation } from './testing';

/*
 * The migrated components. Their classes are imported so the drift check
 * below can read the translation keys straight out of their sources.
 */
import { AdminComponent } from '../components/admin/admin.component';
import { AdminDocumentsComponent } from '../components/admin-documents/admin-documents.component';
import { BillingComponent } from '../components/billing/billing.component';
import { ChangePasswordComponent } from '../components/change-password/change-password.component';
import { ChatComponent } from '../components/chat/chat.component';
import { ConversationsComponent } from '../components/conversations/conversations.component';
import { DocumentsComponent } from '../components/documents/documents.component';
import { ForgotPasswordComponent } from '../components/forgot-password/forgot-password.component';
import { LoginComponent } from '../components/login/login.component';
import { MagicLoginComponent } from '../components/magic-login/magic-login.component';
import { ProfileComponent } from '../components/profile/profile.component';
import { RegisterComponent } from '../components/register/register.component';
import { ResetPasswordComponent } from '../components/reset-password/reset-password.component';
import { SubscriptionsComponent } from '../components/subscriptions/subscriptions.component';
import { VerifyEmailComponent } from '../components/verify-email/verify-email.component';

/**
 * `require` here is resolved by the BUNDLER (webpack), not by Node.
 *
 * This spec runs in a browser (Karma + ChromeHeadless), where Node's `fs`
 * module does not exist: the Angular CLI compiles the test bundle with
 * `node: false`, so `require('fs')` is an unresolvable module (webpack
 * reports "Can't resolve 'fs'" and the module is simply missing at
 * runtime). The CLI does expose one family of files as raw text — a
 * request carrying the `?ngResource` query is served by the `asset/source`
 * module type — and that is the very mechanism the CLI itself uses to
 * inline `templateUrl` files. It is therefore the browser-safe way to read
 * a template file's source text.
 */
declare const require: (id: string) => any;

/** Verbatim template sources, read by webpack (`?ngResource` → asset/source). */
const LOGIN_TEMPLATE = require(
  '../components/login/login.component.html?ngResource'
) as string;
const REGISTER_TEMPLATE = require(
  '../components/register/register.component.html?ngResource'
) as string;
const FORGOT_PASSWORD_TEMPLATE = require(
  '../components/forgot-password/forgot-password.component.html?ngResource'
) as string;
const RESET_PASSWORD_TEMPLATE = require(
  '../components/reset-password/reset-password.component.html?ngResource'
) as string;
const MAGIC_LOGIN_TEMPLATE = require(
  '../components/magic-login/magic-login.component.html?ngResource'
) as string;
const CHANGE_PASSWORD_TEMPLATE = require(
  '../components/change-password/change-password.component.html?ngResource'
) as string;

/**
 * 2-8 (i18n): dictionary contract.
 *
 * Three invariants are pinned here:
 *
 *  1. **Key parity** — `el.json` and `en.json` must expose the exact same
 *     dot-path key set. The runtime falls back to the default language for
 *     a missing key (`useDefaultLang: true`), so a key present in one file
 *     but not the other silently renders the *other* language's copy in a
 *     mixed-language UI. This spec makes that skew a hard failure.
 *
 *  2. **Key resolution** — every translation key referenced by the
 *     migrated components must resolve to a non-empty string in BOTH
 *     dictionaries. A typo in a `| translate` / `instant()` call renders
 *     the raw key ("chat.senMessage") to the user, which no other test
 *     would catch.
 *
 *  3. **No drift** — the component key lists below are the source of
 *     truth for "which keys does this app actually use". They are not
 *     hand-maintained folklore: `COMPONENT_SOURCES` points at the real
 *     component sources and the "no drift" test *derives* the key set at
 *     runtime, then fails when a component references a dictionary-backed
 *     key its list does not mention. The other direction (a list entry
 *     that no longer exists in the dictionaries) is caught by the
 *     "no stale entries" test.
 *
 * How the derivation works:
 *
 *  - **Templates.** The six auth components keep their template in a
 *    dedicated `.html` file, which webpack hands over verbatim through the
 *    CLI's `?ngResource` query. The other nine keep the template INLINE
 *    in the `.ts` file; there the only runtime handle on that text is the
 *    component's own decorator metadata (`__annotations__`), which the JIT
 *    compiler copies into the component definition without altering it.
 *  - **TypeScript.** The `translate.instant('…')` calls and the keys
 *    handed to component-local helpers live in the component's class body,
 *    and string literals survive compilation, so the compiled class source
 *    is searched as well.
 *
 * A dotted string in a component is a translation key when the
 * dictionaries ship it; the dotted strings that are NOT keys
 * (`documents.length`, `msg.createdAt`, …) are template expressions and
 * debug labels, not translations. Keys that are handed straight to the
 * translation service are checked against the dictionaries separately, so
 * a typo there is reported instead of being filtered away.
 *
 * Both sources are read from the component itself, so the key set below
 * can never silently fall out of sync with the code: add a translation to
 * a component and this spec fails until the list mentions it.
 */

/** Flatten a nested dictionary object into its dot-path key set. */
function flattenKeys(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) {
    return prefix ? [prefix] : [];
  }
  const keys: string[] = [];
  for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof value === 'object' && value !== null) {
      keys.push(...flattenKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

const EL_KEYS = flattenKeys(el).sort();
const EN_KEYS = flattenKeys(en).sort();
const EL_KEY_SET = new Set(EL_KEYS);

/** Translation keys referenced by each migrated component. */
const COMPONENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  chat: [
    'chat.article',
    'chat.audioQuestion',
    'chat.audioQuestionTitle',
    'chat.checkoutActivated',
    'chat.checkoutFailed',
    'chat.checkoutSuccess',
    'chat.completed',
    'chat.confidence',
    'chat.copied',
    'chat.copiedAria',
    'chat.copy',
    'chat.copyAria',
    'chat.documentsForQuestion',
    'chat.errors.audio',
    'chat.errors.conversationCreate',
    'chat.errors.loadConversation',
    'chat.errors.model',
    'chat.feedbackAria',
    'chat.feedbackHelpfulAria',
    'chat.feedbackReasonAria',
    'chat.feedbackReasonPlaceholder',
    'chat.feedbackThanks',
    'chat.feedbackUnhelpfulAria',
    'chat.feedbackWasHelpful',
    'chat.inputAria',
    'chat.inputPlaceholder',
    'chat.legalSource',
    'chat.legislation',
    'chat.loadOlder',
    'chat.messagesAria',
    'chat.newConversation',
    'chat.noConversations',
    'chat.notices.slow',
    'chat.notices.timeout',
    'chat.personalDocument',
    'chat.recentAria',
    'chat.regenerate',
    'chat.regenerateAria',
    'chat.send',
    'chat.sendAria',
    'chat.sourcesHide',
    'chat.sourcesShow',
    'chat.stop',
    'chat.stopAria',
    'chat.stopped',
    'chat.submitReason',
    'chat.typing',
    'chat.voiceStart',
    'chat.voiceStop',
    'common.clear',
    'chat.errors.quota',
    'chat.errors.quotaGeneric',
    'common.upgradePlan'
  ],
  documents: [
    'common.cancel',
    'common.close',
    'common.loading',
    'common.search',
    'documents.chooseAria',
    'documents.colFile',
    'documents.colSize',
    'documents.colType',
    'documents.colUploaded',
    'documents.delete',
    'documents.deleteError',
    'documents.deleteMessage',
    'documents.deleteTitle',
    'documents.download',
    'documents.downloadError',
    'documents.dropText',
    'documents.empty',
    'documents.hint',
    'documents.loadError',
    'documents.loadMore',
    'documents.loadingContent',
    'documents.preview',
    'documents.previewAria',
    'documents.previewError',
    'documents.previewTitle',
    'documents.processing',
    'documents.searchAria',
    'documents.searchError',
    'documents.searchPlaceholder',
    'documents.searchSection',
    'documents.similarity',
    'documents.tableAria',
    'documents.title',
    'documents.titleAria',
    'documents.titlePlaceholder',
    'documents.tooLarge',
    'documents.uploadError',
    'documents.uploadSection',
    'documents.uploadedOk',
    'documents.yourDocuments',
    'documents.capReached',
    'documents.capGeneric',
    'common.upgradePlan'
  ],
  conversations: [
    'conversations.cancel',
    'conversations.clear',
    'conversations.colTitle',
    'conversations.colUpdated',
    'conversations.createError',
    'conversations.delete',
    'conversations.deleteError',
    'conversations.deleteMessage',
    'conversations.deleteTitle',
    'conversations.empty',
    'conversations.emptySearch',
    'conversations.loadError',
    'conversations.new',
    'conversations.newTitleAria',
    'conversations.newTitlePlaceholder',
    'conversations.next',
    'conversations.page',
    'conversations.previous',
    'conversations.rename',
    'conversations.renameError',
    'conversations.renameSection',
    'conversations.save',
    'conversations.search',
    'conversations.searchAria',
    'conversations.searchPlaceholder',
    'conversations.tableAria',
    'conversations.title'
  ],
  billing: [
    'billing.active',
    'billing.cancelled',
    'billing.completed',
    'billing.current',
    'billing.loadPlansError',
    'billing.loadSubscriptionError',
    'billing.loadingPlans',
    'billing.manage',
    'billing.manageError',
    'billing.maxPlan',
    'billing.noSubscription',
    'billing.reactivate',
    'billing.reactivateError',
    'billing.reactivatedOk',
    'billing.recommended',
    'billing.redirecting',
    'billing.status',
    'billing.subscription',
    'billing.title',
    'billing.upgrade',
    'billing.upgradeError'
  ],
  subscriptions: [
    'billing.reactivate',
    'billing.reactivateError',
    'billing.reactivatedOk',
    'subscriptions.cancel',
    'subscriptions.cancelBack',
    'subscriptions.cancelError',
    'subscriptions.cancelMessage',
    'subscriptions.cancelTitle',
    'subscriptions.cancelledOk',
    'subscriptions.changePlan',
    'subscriptions.colCreated',
    'subscriptions.colInvoiceAmount',
    'subscriptions.colInvoiceDate',
    'subscriptions.colInvoiceLink',
    'subscriptions.colInvoiceStatus',
    'subscriptions.colPeriodEnd',
    'subscriptions.colStatus',
    'subscriptions.current',
    'subscriptions.downloadPdf',
    'subscriptions.expires',
    'subscriptions.history',
    'subscriptions.historyAria',
    'subscriptions.historyEmpty',
    'subscriptions.loadError',
    'subscriptions.nextPage',
    'subscriptions.none',
    'subscriptions.pageOf',
    'subscriptions.paymentHistory',
    'subscriptions.paymentHistoryAria',
    'subscriptions.paymentHistoryEmpty',
    'subscriptions.paymentHistoryError',
    'subscriptions.paymentHistoryLoading',
    'subscriptions.planLabel',
    'subscriptions.prevPage',
    'subscriptions.status',
    'subscriptions.title',
    'subscriptions.viewInvoice'
  ],
  profile: [
    'profile.account',
    'profile.busy',
    'profile.cancel',
    'profile.delete',
    'profile.deleteConfirm',
    'profile.deleteError',
    'profile.deleteMessage',
    'profile.deleteTitle',
    'profile.deletionScheduledTitle',
    'profile.deletionScheduledMessage',
    'profile.cancelDeletion',
    'profile.deletionCancelled',
    'profile.cancelDeletionError',
    'profile.emailChangeCurrentPassword',
    'profile.emailChangeEmailPlaceholder',
    'profile.emailChangeHint',
    'profile.emailChangeInvalidEmail',
    'profile.emailChangeNewEmail',
    'profile.emailChangePasswordRequired',
    'profile.emailChangeSameEmail',
    'profile.emailChangeSent',
    'profile.emailChangeSubmit',
    'profile.emailChangeSubmitting',
    'profile.emailChangeTitle',
    'profile.emailChangeWrongPassword',
    'profile.export',
    'profile.exportError',
    'profile.exportOk',
    'profile.gdpr',
    'profile.loadError',
    'profile.planLabel',
    'profile.subscriptionStatus',
    'profile.title',
    'profile.until',
    'profile.usage',
    'profile.usageAi',
    'profile.usageDocuments',
    'profile.usageUnlimited',
    'profile.usageLoadError'
  ],
  admin: [
    'admin.audit.actionAria',
    'admin.audit.actionPlaceholder',
    'admin.audit.clear',
    'admin.audit.colAction',
    'admin.audit.colChange',
    'admin.audit.colIp',
    'admin.audit.colResource',
    'admin.audit.colUser',
    'admin.audit.colWhen',
    'admin.audit.empty',
    'admin.audit.filter',
    'admin.audit.loading',
    'admin.audit.next',
    'admin.audit.pager',
    'admin.audit.previous',
    'admin.audit.tableAria',
    'admin.audit.title',
    'admin.audit.userIdAria',
    'admin.audit.userIdPlaceholder',
    'admin.clear',
    'admin.feedback.eyebrow',
    'admin.feedback.helpfulLabel',
    'admin.feedback.helpfulPercent',
    'admin.feedback.lastDays',
    'admin.feedback.none',
    'admin.feedback.title',
    'admin.feedback.totalLabel',
    'admin.feedback.unhelpfulLabel',
    'admin.feedback.window',
    'admin.feedback.windowAria',
    'admin.loadAuditError',
    'admin.loadUsersError',
    'admin.magic.body',
    'admin.magic.dismiss',
    'admin.magic.title',
    'admin.openDocuments',
    'admin.openDocumentsTitle',
    'admin.refreshUsers',
    'admin.refreshing',
    'admin.search',
    'admin.searchUsers',
    'admin.selfDemoteError',
    'admin.signedInAs',
    'admin.toastDismiss',
    'admin.updateFailed',
    'admin.users.colCreated',
    'admin.users.colEmail',
    'admin.users.colId',
    'admin.users.colRole',
    'admin.users.colTier',
    'admin.users.empty',
    'admin.users.emptySearch',
    'admin.users.loading',
    'admin.users.next',
    'admin.users.pager',
    'admin.users.previous',
    'admin.users.roleTitle',
    'admin.users.tableAria',
    'admin.users.tierTitle',
    'admin.users.title',
    'admin.users.you',
    'admin.users.youTitle'
  ],
  adminDocuments: [
    'adminDocuments.clear',
    'adminDocuments.colChunks',
    'adminDocuments.colFile',
    'adminDocuments.colType',
    'adminDocuments.colUploaded',
    'adminDocuments.colUser',
    'adminDocuments.delete',
    'adminDocuments.deleteError',
    'adminDocuments.deleteMessage',
    'adminDocuments.deleteTitle',
    'adminDocuments.empty',
    'adminDocuments.loadError',
    'adminDocuments.loading',
    'adminDocuments.next',
    'adminDocuments.pager',
    'adminDocuments.previous',
    'adminDocuments.search',
    'adminDocuments.searchPlaceholder',
    'adminDocuments.tableAria',
    'adminDocuments.title',
    'adminDocuments.userIdAria',
    'adminDocuments.userIdPlaceholder',
    'common.cancel'
  ],
  // The seven auth surfaces. Each group holds the keys the component
  // itself references: the copy in its template plus the
  // `translate.instant()` calls in its TypeScript. Shared `common.*`
  // entries are listed in the group that uses them; a key may legitimately
  // appear in more than one group.
  authLogin: [
    'auth.authOptions',
    'auth.login.authenticating',
    'auth.login.createAccount',
    'auth.login.emailPlaceholder',
    'auth.login.forgotIt',
    'auth.login.forgotPassword',
    'auth.login.passwordPlaceholder',
    'auth.login.resend',
    'auth.login.resendMessage',
    'auth.login.sending',
    'auth.login.signIn',
    'auth.login.subtitle',
    'auth.login.title',
    'common.email',
    'common.fillAll',
    'common.hidePassword',
    'common.password',
    'common.showPassword'
  ],
  authRegister: [
    'auth.authOptions',
    'auth.register.checkEmail',
    'auth.register.clickLink',
    'auth.register.confirmPlaceholder',
    'auth.register.createAccount',
    'auth.register.creating',
    'auth.register.emailPlaceholder',
    'auth.register.haveAccount',
    'auth.register.notArrived',
    'auth.register.passwordPlaceholder',
    'auth.register.resend',
    'auth.register.resendMessage',
    'auth.register.sending',
    'auth.register.sentToPrefix',
    'auth.register.subtitle',
    'auth.register.title',
    'common.backToSignIn',
    'common.confirmPassword',
    'common.email',
    'common.fillAll',
    'common.hideConfirmPassword',
    'common.hidePassword',
    'common.invalidEmail',
    'common.password',
    'common.passwordMin',
    'common.passwordsMismatch',
    'common.showConfirmPassword',
    'common.showPassword'
  ],
  authForgot: [
    'auth.forgot.sending',
    'auth.forgot.submit',
    'auth.forgot.subtitle',
    'auth.forgot.success',
    'auth.forgot.title',
    'auth.login.emailPlaceholder',
    'common.backToSignIn',
    'common.email',
    'common.enterEmail',
    'common.invalidEmail'
  ],
  authReset: [
    'auth.reset.confirmPlaceholder',
    'auth.reset.missingToken',
    'auth.reset.missingTokenError',
    'auth.reset.newPasswordPlaceholder',
    'auth.reset.resetting',
    'auth.reset.submit',
    'auth.reset.subtitle',
    'auth.reset.success',
    'auth.reset.title',
    'common.backToSignIn',
    'common.confirmPassword',
    'common.fillAll',
    'common.newPassword',
    'common.passwordMin',
    'common.passwordsMismatch'
  ],
  authVerify: [
    'auth.verify.changeInvalid',
    'auth.verify.changeSuccess',
    'auth.verify.changeWaiting',
    'auth.verify.invalid',
    'auth.verify.success',
    'auth.verify.title',
    'auth.verify.waiting',
    'common.backToSignIn'
  ],
  authMagic: [
    'auth.magic.noToken',
    'auth.magic.success',
    'auth.magic.title',
    'auth.magic.waiting',
    'common.backToSignIn'
  ],
  authChange: [
    'auth.authOptions',
    'auth.change.backToWorkspace',
    'auth.change.confirmPlaceholder',
    'auth.change.currentPlaceholder',
    'auth.change.mismatch',
    'auth.change.newPasswordPlaceholder',
    'auth.change.sameAsCurrent',
    'auth.change.subtitle',
    'auth.change.success',
    'auth.change.title',
    'auth.change.update',
    'auth.change.updating',
    'common.confirmPassword',
    'common.currentPassword',
    'common.fillAll',
    'common.hideConfirmPassword',
    'common.hideCurrentPassword',
    'common.hideNewPassword',
    'common.newPassword',
    'common.passwordMin',
    'common.showConfirmPassword',
    'common.showCurrentPassword',
    'common.showNewPassword'
  ],
  // Shared vocabulary for the machine-readable auth error codes returned by
  // the backend (`backend/src/constants/authErrors.js`) and consumed by the
  // login / register / verify-email / magic-login flows through
  // `authErrorMessage()` in `services/auth.service.ts`.
  //
  // `common.tooManyRequests` belongs here too: it is the copy the auth
  // surface shows when the backend rate-limits an auth endpoint, so it is
  // part of the same shared auth vocabulary rather than a component-local
  // string. (The group has no component of its own, so it is not part of
  // the derived drift check — the dictionary tests above still pin it.)
  authErrors: [
    'auth.errors.invalidCredentials',
    'auth.errors.unverifiedEmail',
    'auth.errors.emailTaken',
    'auth.errors.invalidToken',
    'auth.errors.invalidRequest',
    'auth.errors.passwordChangeFailed',
    'auth.errors.userNotFound',
    'auth.errors.adminRoleRequired',
    'auth.errors.adminRegistrationForbidden',
    'auth.errors.notFound',
    'auth.errors.requestAccepted',
    'auth.errors.serverError',
    'auth.errors.network',
    'common.tooManyRequests'
  ]
};

const ALL_COMPONENT_KEYS: string[] = Object.values(COMPONENT_KEYS).reduce<string[]>(
  (acc, keys) => acc.concat(keys),
  []
);

const LANGUAGES: readonly AppLanguage[] = ['el', 'en'];

/**
 * Where the keys of every component group are read from at runtime.
 *
 * `template` — the component's template file, handed over verbatim by
 *   webpack (`?ngResource` → `asset/source`). Six auth components have one;
 *   the rest keep their template inline in the `.ts` file, where it is
 *   read from the component's own metadata instead (see `inlineTemplate`).
 * `component` — the component class. Its decorator metadata carries the
 *   template, and its compiled source carries the `translate.instant()`
 *   calls and the keys passed to component-local helpers.
 */
interface ComponentSources {
  readonly template?: readonly string[];
  readonly component?: unknown;
}

const COMPONENT_SOURCES: Readonly<Record<string, ComponentSources>> = {
  chat: { component: ChatComponent },
  documents: { component: DocumentsComponent },
  conversations: { component: ConversationsComponent },
  billing: { component: BillingComponent },
  subscriptions: { component: SubscriptionsComponent },
  profile: { component: ProfileComponent },
  admin: { component: AdminComponent },
  adminDocuments: { component: AdminDocumentsComponent },
  authLogin: { template: [LOGIN_TEMPLATE], component: LoginComponent },
  authRegister: {
    template: [REGISTER_TEMPLATE],
    component: RegisterComponent
  },
  authForgot: {
    template: [FORGOT_PASSWORD_TEMPLATE],
    component: ForgotPasswordComponent
  },
  authReset: {
    template: [RESET_PASSWORD_TEMPLATE],
    component: ResetPasswordComponent
  },
  authVerify: {
    component: VerifyEmailComponent
  },
  authMagic: { template: [MAGIC_LOGIN_TEMPLATE], component: MagicLoginComponent },
  authChange: {
    template: [CHANGE_PASSWORD_TEMPLATE],
    component: ChangePasswordComponent
  }
};

/** A dotted key candidate, e.g. `auth.login.title`. */
const DOTTED_KEY = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;

/** Every quoted, dotted string inside a chunk of text. */
function quotedDottedKeys(text: string): string[] {
  const keys: string[] = [];
  const quoted = /(['"`])([^'"`\n]*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(text)) !== null) {
    const value = match[2].trim();
    if (DOTTED_KEY.test(value)) {
      keys.push(value);
    }
  }
  return keys;
}

/**
 * The keys a template pipes through `| translate`.
 *
 * The operand of the pipe is either a quoted key (`'auth.login.title'`) or
 * a ternary of quoted keys (`(a ? 'x' : 'y')`), so both shapes are
 * handled by walking back from the pipe to its operand.
 */
function templateKeys(source: string): string[] {
  const keys: string[] = [];
  const pipe = /\|\s*translate\b/g;
  let match: RegExpExecArray | null;
  while ((match = pipe.exec(source)) !== null) {
    let end = match.index - 1;
    while (end >= 0 && /\s/.test(source[end])) {
      end--;
    }
    if (end < 0) {
      continue;
    }
    const last = source[end];
    if (last === ')') {
      let depth = 0;
      let start = end;
      while (start >= 0) {
        if (source[start] === ')') {
          depth++;
        } else if (source[start] === '(') {
          depth--;
          if (depth === 0) {
            break;
          }
        }
        start--;
      }
      keys.push(...quotedDottedKeys(source.slice(start + 1, end)));
    } else if (last === "'" || last === '"' || last === '`') {
      const start = source.lastIndexOf(last, end - 1);
      if (start < 0) {
        continue;
      }
      const value = source.slice(start + 1, end).trim();
      if (DOTTED_KEY.test(value)) {
        keys.push(value);
      }
    }
  }
  return keys;
}

/** The keys passed to `translate.instant('…')` (and friends). */
function serviceKeys(source: string): string[] {
  const keys: string[] = [];
  const call =
    /translate\s*\.\s*(?:instant|get|stream|getTranslation)\s*\(\s*(['"])([^'"\n]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    const value = match[2].trim();
    if (DOTTED_KEY.test(value)) {
      keys.push(value);
    }
  }
  return keys;
}

/**
 * The template of a component that keeps it INLINE in its `.ts` file.
 *
 * Angular's `Component` decorator keeps the metadata it was given on the
 * class (`__annotations__`); the JIT compiler copies the template out of
 * it without changing it, so the text is the component's own source.
 */
function inlineTemplate(component: unknown): string | undefined {
  const annotations = (
    component as { __annotations__?: ReadonlyArray<Record<string, unknown>> }
  )?.__annotations__;
  for (const annotation of annotations ?? []) {
    const template = annotation?.['template'];
    if (typeof template === 'string' && template.length > 0) {
      return template;
    }
  }
  return undefined;
}

/**
 * The source of a component class.
 *
 * `String(cls)` yields the class body, which is where the
 * `translate.instant('…')` calls live. The prototype methods are read as
 * well so the extraction keeps working if the class is ever down-levelled
 * to a constructor function with prototype methods.
 */
function componentSource(component: unknown): string {
  const chunks: string[] = [];
  try {
    chunks.push(String(component));
  } catch {
    /* not representable — nothing to extract */
  }
  const prototype = (component as { prototype?: object } | null)?.prototype;
  if (prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor && typeof descriptor.value === 'function') {
        try {
          chunks.push(String(descriptor.value));
        } catch {
          /* not representable — nothing to extract */
        }
      }
    }
  }
  return chunks.join('\n');
}

/** The template texts a component group is read from. */
function templateTexts(sources: ComponentSources): string[] {
  if (sources.template) {
    return [...sources.template];
  }
  const inline = inlineTemplate(sources.component);
  return inline ? [inline] : [];
}

/**
 * Every dictionary-backed key a component group references.
 *
 * A dotted string in a component is a translation key when the
 * dictionaries ship it — that covers the keys written straight into a
 * template, the ones passed to `translate.instant()` and the ones handed
 * to a component-local helper (`describeError(err, 'chat.errors.model')`).
 * The dictionary is the filter: the dotted strings that are NOT keys
 * (`documents.length`, `msg.createdAt`, …) are template expressions and
 * debug labels, not translations.
 */
function derivedKeys(sources: ComponentSources): string[] {
  const keys = new Set<string>();
  const add = (candidates: string[]): void => {
    for (const key of candidates) {
      if (EL_KEY_SET.has(key)) {
        keys.add(key);
      }
    }
  };
  for (const template of templateTexts(sources)) {
    add(quotedDottedKeys(template));
  }
  if (sources.component !== undefined) {
    add(quotedDottedKeys(componentSource(sources.component)));
  }
  return [...keys].sort();
}

/**
 * The keys a component group passes straight to the translation service.
 *
 * Unlike `derivedKeys` these are NOT filtered by the dictionary: a key
 * that is missing from the dictionaries is a live bug (the UI renders the
 * raw key), so it has to be reported instead of being ignored.
 */
function directKeys(sources: ComponentSources): string[] {
  const keys = new Set<string>();
  for (const template of templateTexts(sources)) {
    for (const key of templateKeys(template)) {
      keys.add(key);
    }
  }
  if (sources.component !== undefined) {
    for (const key of serviceKeys(componentSource(sources.component))) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

describe('i18n dictionaries (2-8)', () => {
  it('el.json and en.json expose the exact same key set', () => {
    const elSet = new Set(EL_KEYS);
    const enSet = new Set(EN_KEYS);

    const missingInEn = EL_KEYS.filter((key) => !enSet.has(key));
    const missingInEl = EN_KEYS.filter((key) => !elSet.has(key));

    expect(missingInEn).toEqual([]);
    expect(missingInEl).toEqual([]);
    expect(EN_KEYS.length).toBe(EL_KEYS.length);
  });

  it('ships a non-empty dictionary for every language', () => {
    expect(EL_KEYS.length).toBeGreaterThan(0);
    expect(EN_KEYS.length).toBeGreaterThan(0);
  });

  it('every key referenced by the migrated components resolves in el', () => {
    const unresolved = ALL_COMPONENT_KEYS.filter(
      (key) => !lookupTranslation('el', key)
    );
    expect(unresolved).toEqual([]);
  });

  it('every key referenced by the migrated components resolves in en', () => {
    const unresolved = ALL_COMPONENT_KEYS.filter(
      (key) => !lookupTranslation('en', key)
    );
    expect(unresolved).toEqual([]);
  });

  it('every component key resolves to a non-empty string in both languages', () => {
    for (const key of ALL_COMPONENT_KEYS) {
      for (const lang of LANGUAGES) {
        const value = lookupTranslation(lang, key);
        expect(value)
          .withContext(`${lang}:${key}`)
          .toBeDefined();
        expect((value ?? '').trim().length)
          .withContext(`${lang}:${key}`)
          .toBeGreaterThan(0);
      }
    }
  });

  it('covers the 15 migrated components plus the shared auth error vocabulary', () => {
    expect(Object.keys(COMPONENT_KEYS).sort()).toEqual([
      'admin',
      'adminDocuments',
      'authChange',
      'authErrors',
      'authForgot',
      'authLogin',
      'authMagic',
      'authRegister',
      'authReset',
      'authVerify',
      'billing',
      'chat',
      'conversations',
      'documents',
      'profile',
      'subscriptions'
    ]);
  });

  it('uses each component key only once (no stale duplicates)', () => {
    // Uniqueness is checked *within* a component's list. A key may legitimately
    // be shared across components (e.g. `common.cancel` is used by both the
    // documents and the admin-documents delete dialogs) — that is reuse, not a
    // stale duplicate. A duplicate *inside* one list is the real bug class:
    // it means a key was renamed in the component but the old entry lingered.
    const duplicated: string[] = [];
    for (const [component, keys] of Object.entries(COMPONENT_KEYS)) {
      const seen = new Set<string>();
      for (const key of keys) {
        if (seen.has(key)) {
          duplicated.push(`${component}: ${key}`);
        }
        seen.add(key);
      }
    }
    expect(duplicated).toEqual([]);
  });

  it('lists no key that the dictionaries do not ship (no stale entries)', () => {
    // The reverse direction of the drift check: a key that was removed from
    // the dictionaries (or renamed) must not linger in the component lists.
    const stale = ALL_COMPONENT_KEYS.filter((key) => !EL_KEY_SET.has(key));
    expect(stale).toEqual([]);
  });

  it('derives the component keys from the sources and finds them all listed', () => {
    // The drift guard. The key set is DERIVED from the component sources
    // (the template text and the compiled class source) instead of being
    // trusted: a component that starts using a new key — or a typo that
    // renames one — must show up here.
    const notListed: string[] = [];
    const notInDictionary: string[] = [];

    for (const [group, sources] of Object.entries(COMPONENT_SOURCES)) {
      // Guard the readers themselves: a source that cannot be read must
      // fail loudly instead of silently deriving nothing.
      expect(templateTexts(sources).length)
        .withContext(`${group}: no template could be read`)
        .toBeGreaterThan(0);
      expect(sources.component)
        .withContext(`${group}: no component class to read`)
        .toBeDefined();

      const derived = derivedKeys(sources);
      expect(derived.length)
        .withContext(`${group}: no key could be derived`)
        .toBeGreaterThan(0);

      const listed = new Set(COMPONENT_KEYS[group] ?? []);
      for (const key of derived) {
        // A dictionary-backed key the component list forgot is the drift
        // this file exists to catch.
        if (!listed.has(key)) {
          notListed.push(`${group}: ${key}`);
        }
      }

      // A key handed straight to the translation service that no
      // dictionary ships is a live bug: the UI renders the raw key.
      for (const key of directKeys(sources)) {
        if (!EL_KEY_SET.has(key)) {
          notInDictionary.push(`${group}: ${key}`);
        }
      }
    }

    expect(notInDictionary).toEqual([]);
    expect(notListed).toEqual([]);
  });
});
