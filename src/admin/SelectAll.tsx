"use client";
/** "Select all" checkbox for the rows of a bulk form (checkboxes named `name`). */
export function SelectAll({ form, name }: { form: string; name: string }) {
  return (
    <input type="checkbox" aria-label="تحديد الكل" className="w-4 h-4"
      onChange={(e) => {
        document.querySelectorAll<HTMLInputElement>(`input[form="${form}"][name="${name}"]`).forEach((c) => { c.checked = e.target.checked; });
      }} />
  );
}
