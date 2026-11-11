-- Storytellers read every whisper at their tables.
--
-- Whispers are spoken in character, and the storyteller plays everyone the characters talk
-- about and keeps the story together, so they hear every whisper, the way a game master is
-- handed every note passed at the table. Players still read only the whispers they sent or
-- received. Live updates follow the same policy, so a storyteller's feed gets whispers as
-- they are sent.

drop policy "the table reads its chat, a whisper only its sender and recipient" on public.messages;

create policy "the table reads its chat, a whisper its two people and the storytellers" on public.messages
  for select to authenticated
  using (public.at_table(table_id)
         and (to_user is null or user_id = auth.uid() or to_user = auth.uid()
              or public.is_storyteller(chronicle_id)));
