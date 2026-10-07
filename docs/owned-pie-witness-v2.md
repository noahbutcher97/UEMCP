# Owned PIE property witness v2

The independently authored fixture uses `InputPriority: 173` instead of the v1
`CustomTimeDilation: 0.5` witness. This is a new fixture contract; successful v2
execution does not qualify v1 time-dilation stability. The saved v1 maps, receipts,
live failure, and separate process recovery remain preserved.

UE5.6 `AActor::InputPriority` is an editable, nontransient int32. The construction
reset predicate excludes it. The existing PIE property reader serializes the
integer directly. Automatic input must be disabled and the input component absent
in authored/reloaded, editor, and both PIE actor observations, so the priority
witness does not activate input. Its nondefault value proves that the actual
observed instance retains authored property data through save, load, construction,
and PIE duplication. Exact class, name, map, transform and missing-actor probes
continue to establish actor/world identity.

Authoring checks the reflected property type/owner/flags and native class defaults.
It performs a genuine construction rerun on the disposable actor, with the former
scalar set to .5 only as a sensitivity control: that scalar must reset to CDO1,
while InputPriority remains173 without reassignment. All actor/root/world and
safety checks surround callbacks and saving. Readonly verification never sets
either property or saves the map.

Two start/runtime/stop cycles, typed negative probes, one standalone world,
operation accounting, permanent native fence, later post-editor drain, absolute
deadlines, exclusive ownership, memory isolation and exact-identity cleanup remain
required. Offline controls reject missing, default, wrong, fractional and mistyped
witnesses and missing or unsafe input proof. Native qualification remains unproven
until the actual affected build, author, fresh reload and live cycle runs pass.
