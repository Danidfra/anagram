<script lang="ts">
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  export let publicKey: string;
  export let fallback = '';
  export let givenName = '';
  $: profile = observePublicProfile(publicKey);
</script>

{givenName || $profile?.name || fallback}
