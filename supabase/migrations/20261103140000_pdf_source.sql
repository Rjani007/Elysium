-- Characters can also come from a filled-in official V5 character sheet (PDF). The browser
-- reads the PDF's form fields (site/js/officialsheet.js); only the resulting sheet is stored.
alter table public.characters drop constraint characters_source_check;
alter table public.characters add constraint characters_source_check
  check (source in ('manual', 'mundusmaker', 'progeny', 'pdf'));
