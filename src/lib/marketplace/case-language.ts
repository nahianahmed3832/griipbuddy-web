import type { OrderCaseKind, OrderCaseStatus } from "../../generated/prisma/enums.ts";
import { accountText, type AccountLanguage } from "./account-language.ts";
import { caseKindLabels, caseStatusLabels, type CaseReason } from "./case-policy.ts";

const banglaKinds: Record<OrderCaseKind, string> = {
  RETURN: "ফেরতের অনুরোধ",
  EXCHANGE: "বদলের অনুরোধ",
  DISPUTE: "অর্ডার নিয়ে সহায়তা",
  CANCEL: "বাতিলের অনুরোধ",
};

const banglaStatuses: Record<OrderCaseStatus, string> = {
  OPEN: "জমা হয়েছে",
  IN_REVIEW: "পর্যালোচনা চলছে",
  RETURN_APPROVED: "ফেরত অনুমোদিত",
  RETURN_RECEIVED: "ফেরত পণ্য গ্রহণ করা হয়েছে",
  EXCHANGE_SHIPPED: "বদলি পণ্য পাঠানো হয়েছে",
  REFUND_APPROVED: "টাকা ফেরতের অপেক্ষায়",
  REFUND_FAILED: "টাকা ফেরতে সমস্যা হয়েছে",
  DECLINED: "অনুরোধ অনুমোদিত হয়নি",
  RESOLVED: "সমাধান হয়েছে",
  WITHDRAWN: "অনুরোধ প্রত্যাহার করা হয়েছে",
};

const reasons: Record<CaseReason, readonly [string, string]> = {
  DELIVERY: ["Delivery issue", "ডেলিভারিতে সমস্যা"],
  DAMAGED: ["Damaged or defective item", "ক্ষতিগ্রস্ত বা ত্রুটিপূর্ণ পণ্য"],
  WRONG_ITEM: ["Wrong or missing item", "ভুল পণ্য এসেছে বা পণ্য পাওয়া যায়নি"],
  CHANGED_MIND: ["Changed my mind", "সিদ্ধান্ত বদলেছি"],
  PAYMENT: ["Payment issue", "পেমেন্টে সমস্যা"],
  OTHER: ["Other reason", "অন্য কারণ"],
};

export function caseKindLabel(language: AccountLanguage, kind: OrderCaseKind) {
  return accountText(language, kind === "DISPUTE" ? "Order help" : caseKindLabels[kind], banglaKinds[kind]);
}

export function caseStatusLabel(language: AccountLanguage, status: OrderCaseStatus) {
  return accountText(language, caseStatusLabels[status], banglaStatuses[status]);
}

export function caseProgressLabel(language: AccountLanguage, { status, refundConfirmedAt }: {
  status: OrderCaseStatus; refundConfirmedAt?: Date | null;
}) {
  return refundConfirmedAt ? accountText(language, "Refund confirmed", "টাকা ফেরত নিশ্চিত হয়েছে") : caseStatusLabel(language, status);
}

export function caseReasonLabel(language: AccountLanguage, reason: string) {
  if (!Object.hasOwn(reasons, reason)) return reason;
  return accountText(language, ...reasons[reason as CaseReason]);
}

const errors: Record<string, string> = {
  "Open this action from the storefront.": "স্টোরফ্রন্ট থেকে এই কাজটি খুলুন।",
  "Check the case details and try again.": "অনুরোধের বিবরণ যাচাই করে আবার চেষ্টা করুন।",
  "Sign in to continue.": "এগিয়ে যেতে সাইন ইন করুন।",
  "Too many actions. Try again shortly.": "অল্প সময়ে অনেকবার চেষ্টা করা হয়েছে। একটু পরে আবার চেষ্টা করুন।",
  "You don’t have permission for that action.": "এই কাজের অনুমতি আপনার নেই।",
  "Order not found.": "অর্ডারটি পাওয়া যায়নি।",
  "Case not found.": "অনুরোধটি পাওয়া যায়নি।",
  "A return can be requested after delivery.": "ডেলিভারির পরে ফেরতের অনুরোধ করা যায়।",
  "An exchange can only be requested for an eligible delivered Bangladesh order.": "যোগ্য বাংলাদেশি অর্ডার ডেলিভারির পর পণ্য বদলের অনুরোধ করা যায়।",
  "Contact support to discuss a return for this order.": "এই অর্ডার ফেরত দেওয়ার বিষয়ে সহায়তা দলের সঙ্গে যোগাযোগ করুন।",
  "This order can no longer be cancelled online. Ask support for help.": "এই অর্ডারটি এখন অনলাইনে বাতিল করা যাবে না। সহায়তার জন্য যোগাযোগ করুন।",
  "Choose an item from this order.": "এই অর্ডার থেকে একটি পণ্য বেছে নিন।",
  "An active case of this type already exists for this order.": "এই অর্ডারে একই ধরনের একটি অনুরোধ ইতিমধ্যে চালু আছে।",
  "An active request already exists for this order.": "এই অর্ডারের জন্য একটি অনুরোধ ইতিমধ্যে চালু আছে।",
  "Choose the item and quantity you want to return.": "ফেরত দিতে চান এমন পণ্য ও পরিমাণ বেছে নিন।",
  "Choose the item and quantity for this request.": "এই অনুরোধের জন্য পণ্য ও পরিমাণ বেছে নিন।",
  "Choose a replacement for every item you want to exchange.": "প্রতিটি বদলের পণ্যের জন্য একটি বিকল্প বেছে নিন।",
  "Contact GriipBuddy about this order’s previous return before opening another request.": "নতুন অনুরোধ করার আগে এই অর্ডারের আগের ফেরত নিয়ে GriipBuddy-এর সঙ্গে যোগাযোগ করুন।",
  "One of the selected quantities is no longer available to return.": "বেছে নেওয়া একটি পরিমাণ এখন ফেরত দেওয়া যাবে না।",
  "This request does not accept item selection.": "এই অনুরোধে পণ্য বেছে নেওয়া যায় না।",
  "This case changed. Refresh the page and try again.": "অনুরোধটি বদলেছে। পৃষ্ঠা রিফ্রেশ করে আবার চেষ্টা করুন।",
  "This case changed while you were working. Refresh the page and try again.": "অনুরোধটি বদলেছে। পৃষ্ঠা রিফ্রেশ করে আবার চেষ্টা করুন।",
  "That action is unavailable for the current case status.": "এই অবস্থায় কাজটি করা যাবে না।",
  "Upload a JPEG, PNG, or WebP image up to 4 MB.": "সর্বোচ্চ ৪ এমবি আকারের JPEG, PNG বা WebP ছবি দিন।",
  "The image could not be read. Use a still JPEG, PNG, or WebP under 16 megapixels.": "ছবিটি পড়া যায়নি। ১৬ মেগাপিক্সেলের কম স্থির JPEG, PNG বা WebP ছবি দিন।",
  "The processed image is too large. Use a smaller image.": "ছবিটি বড় হয়ে গেছে। ছোট একটি ছবি দিন।",
  "We couldn't save this change. Try again.": "পরিবর্তনটি সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।",
};

export function caseErrorLabel(language: AccountLanguage, message: string) {
  return accountText(language, message, Object.hasOwn(errors, message) ? errors[message] : "অনুরোধটি সম্পন্ন করা যায়নি। তথ্য যাচাই করে আবার চেষ্টা করুন।");
}
