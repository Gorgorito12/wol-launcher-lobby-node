/**
 * The achievements (design 121 "Logros"): which medals exist, in which game, and what each asks.
 *
 * <p><b>Counted per game.</b> Every medal is earned by a match (or tournament) OF THAT GAME, keyed
 * by the room's mod id lowercased ({@link modKeyOf}). The Asian Dynasties ({@link TAD_KEY}) has a
 * set of its own; every other mod — Wars of Liberty first — uses the {@link GENERAL_SET}.</p>
 *
 * <p><b>This is data.</b> The evaluator (evaluate.ts) knows the KINDS below and nothing about
 * individual medals, so moving a medal to another metal, changing a goal or reordering a group is
 * an edit here and nowhere else. The launcher draws whatever groups and items the payload carries,
 * in this order; its own string table names them, and an id it does not know falls back to the
 * English name sent with it.</p>
 *
 * <p>The civilization and map lists were read from the games themselves on 2026-11-21: TAD's
 * civs.xml through the launcher's CivNameResolver (a Spanish install, hence the Spanish aliases),
 * Wars of Liberty 1.2.0e's civs.xml (every block not marked `visible 0`, without the campaign
 * civilizations), and TAD's RM3 map scripts. A name the history holds that these lists do not
 * know is printed by `achievements:backfill` — that is the check that they are complete.</p>
 */

export type Metal = 'b' | 's' | 'g';
export type Ladder = 'default' | 'team';

/** What an achievement asks. The evaluator implements each kind once. */
export type AchievementKind =
    | { kind: 'played'; goal: number }
    | { kind: 'won'; goal: number }
    | { kind: 'rated_played'; ladder: Ladder; goal: number }
    | { kind: 'rated_won'; ladder: Ladder; goal: number }
    | { kind: 'elo'; ladder: Ladder; goal: number }
    | { kind: 'graduate'; ladder: Ladder }
    | { kind: 'win_streak'; goal: number }
    | { kind: 'phoenix'; losses: number }
    | { kind: 'giant_slayer'; gap: number }
    | { kind: 'promotion' }
    | { kind: 'on_top' }
    | { kind: 'distinct_civ_wins'; goal: number }
    | { kind: 'every_civ_win' }
    | { kind: 'same_civ_wins'; goal: number }
    | { kind: 'family_civ_wins'; family: CivFamily | 'all' }
    | { kind: 'matchup_win'; mine: CivFamily | readonly string[]; theirs: CivFamily | readonly string[]; either?: boolean }
    | { kind: 'mirror_win' }
    | { kind: 'distinct_maps_played'; goal: number }
    | { kind: 'map_list_wins'; maps: MapList; goal?: number }
    | { kind: 'team_wins'; goal: number }
    | { kind: 'short_win'; maxSeconds: number }
    | { kind: 'long_win'; minSeconds: number }
    | { kind: 'rules_win'; rules: readonly number[] }
    | { kind: 'distinct_opponents'; goal: number }
    | { kind: 'host'; goal: number }
    | { kind: 'champion' }
    | { kind: 'organiser' };

export interface AchievementDef {
    /** Stable id; the launcher's string keys and stored rows use it. Never rename. */
    id: string;
    /** The icon the launcher draws on the medal. */
    icon: string;
    metal: Metal;
    /** English name and condition, sent so a launcher that does not know the id still says something. */
    name: string;
    condition: string;
    rule: AchievementKind;
}

export interface AchievementGroup {
    id: string;
    /** The enamel colour the launcher paints the group's medals with, 0-6 (design 121's table). */
    enamel: number;
    name: string;
    items: readonly AchievementDef[];
}

export type CivFamily = 'european' | 'native' | 'asian';
export type MapList = 'tad_asian' | 'tad_americas';

/** Promotion's five tiers, bottom to top. Tier N is reached by holding that age or a higher one. */
export const PROMOTION_TIERS = ['colonial', 'fortress', 'industrial', 'imperial', 'sovereign'] as const;

export const TAD_KEY = 'aoe3-tad';

/** The room's mod id as the medals key it: trimmed and lowercased. */
export function modKeyOf(modId: string | null | undefined): string {
    return (modId ?? '').trim().toLowerCase();
}

const a = (id: string, icon: string, metal: Metal, name: string, condition: string, rule: AchievementKind):
    AchievementDef => ({ id, icon, metal, name, condition, rule });

const COMPETITIVE_1V1: AchievementGroup = {
    id: 'competitive_1v1', enamel: 2, name: 'Competitive 1v1', items: [
        a('ranked_debut', 'target', 'b', 'Ranked Debut', 'Play your first competitive 1v1',
            { kind: 'rated_played', ladder: 'default', goal: 1 }),
        a('ladder_regular', 'shield', 's', 'Ladder Regular', 'Play 25 competitive 1v1 matches',
            { kind: 'rated_played', ladder: 'default', goal: 25 }),
        a('duelist', 'sword', 'b', 'Duelist', 'Win 10 competitive 1v1 matches',
            { kind: 'rated_won', ladder: 'default', goal: 10 }),
        a('gladiator', 'trophy', 'g', 'Gladiator', 'Win 50 competitive 1v1 matches',
            { kind: 'rated_won', ladder: 'default', goal: 50 }),
        a('contender', 'climb', 'b', 'Contender', 'Reach 1600 ELO in 1v1',
            { kind: 'elo', ladder: 'default', goal: 1600 }),
        a('elite', 'climb', 's', 'Elite', 'Reach 1700 ELO in 1v1',
            { kind: 'elo', ladder: 'default', goal: 1700 }),
        a('legend', 'climb', 'g', 'Legend', 'Reach 1800 ELO in 1v1',
            { kind: 'elo', ladder: 'default', goal: 1800 }),
    ],
};

const COMPETITIVE_TEAMS: AchievementGroup = {
    id: 'competitive_teams', enamel: 3, name: 'Competitive teams', items: [
        a('team_debut', 'people', 'b', 'Team Debut', 'Play your first competitive team match',
            { kind: 'rated_played', ladder: 'team', goal: 1 }),
        a('team_graduate', 'cap', 'b', 'Team Graduate', 'Finish your placement matches in Teams',
            { kind: 'graduate', ladder: 'team' }),
        a('squadmate', 'shield', 's', 'Squadmate', 'Play 25 competitive team matches',
            { kind: 'rated_played', ladder: 'team', goal: 25 }),
        a('coalition', 'flag', 's', 'Coalition', 'Win 10 competitive team matches',
            { kind: 'rated_won', ladder: 'team', goal: 10 }),
        a('grand_alliance', 'crown', 'g', 'Grand Alliance', 'Win 50 competitive team matches',
            { kind: 'rated_won', ladder: 'team', goal: 50 }),
        a('vanguard', 'climb', 'b', 'Vanguard', 'Reach 1600 ELO in Teams',
            { kind: 'elo', ladder: 'team', goal: 1600 }),
        a('old_guard', 'climb', 's', 'Old Guard', 'Reach 1700 ELO in Teams',
            { kind: 'elo', ladder: 'team', goal: 1700 }),
        a('high_command', 'climb', 'g', 'High Command', 'Reach 1800 ELO in Teams',
            { kind: 'elo', ladder: 'team', goal: 1800 }),
    ],
};

const FIRST_BLOOD = a('first_blood', 'check', 'b', 'First Blood', 'Win your first match', { kind: 'won', goal: 1 });
const CONQUEROR = a('conqueror', 'trophy', 's', 'Conqueror', 'Win 50 matches', { kind: 'won', goal: 50 });
const UNSTOPPABLE = a('unstoppable', 'flame', 's', 'Unstoppable', 'Win 5 matches in a row', { kind: 'win_streak', goal: 5 });
const GIANT_SLAYER = a('giant_slayer', 'climb', 'g', 'Giant Slayer', 'Beat someone with 200 more ELO', { kind: 'giant_slayer', gap: 200 });
const PROMOTION = a('promotion', 'promotion', 'b', 'Promotion', 'Reach an age of the ranking: one medal per age', { kind: 'promotion' });
const DIPLOMAT = a('diplomat', 'people', 'b', 'Diplomat', 'Play against 25 different players', { kind: 'distinct_opponents', goal: 25 });
const CHAMPION = a('champion', 'trophy', 'g', 'Champion', 'Win a tournament', { kind: 'champion' });

/** Wars of Liberty, and every mod without a set of its own. */
export const GENERAL_SET: readonly AchievementGroup[] = [
    {
        id: 'first_steps', enamel: 0, name: 'First steps', items: [
            a('baptism_of_fire', 'sword', 'b', 'Baptism of Fire', 'Play your first multiplayer match', { kind: 'played', goal: 1 }),
            FIRST_BLOOD,
            a('veteran', 'shield', 's', 'Veteran', 'Play 100 matches', { kind: 'played', goal: 100 }),
            CONQUEROR,
        ],
    },
    {
        id: 'streaks_ranking', enamel: 1, name: 'Streaks and ranking', items: [
            UNSTOPPABLE,
            a('phoenix', 'phoenix', 'b', 'Phoenix', 'Win after losing 3 in a row', { kind: 'phoenix', losses: 3 }),
            GIANT_SLAYER,
            a('graduate', 'cap', 'b', 'Graduate', 'Finish your placement matches', { kind: 'graduate', ladder: 'default' }),
            PROMOTION,
            a('on_top', 'crown', 'g', 'On Top', 'Enter the podium (top 3)', { kind: 'on_top' }),
        ],
    },
    COMPETITIVE_1V1,
    COMPETITIVE_TEAMS,
    {
        id: 'civs_maps', enamel: 4, name: 'Civilizations and maps', items: [
            a('ambassador', 'flag', 's', 'Ambassador', 'Win with 10 different civilizations', { kind: 'distinct_civ_wins', goal: 10 }),
            a('citizen_of_the_world', 'globe', 'g', 'Citizen of the World', 'Win with every civilization of the mod', { kind: 'every_civ_win' }),
            a('specialist', 'star', 's', 'Specialist', 'Win 25 matches with the same civilization', { kind: 'same_civ_wins', goal: 25 }),
            a('cartographer', 'compass', 's', 'Cartographer', 'Play on 20 different maps', { kind: 'distinct_maps_played', goal: 20 }),
        ],
    },
    {
        id: 'formats', enamel: 5, name: 'Formats', items: [
            a('brothers_in_arms', 'people', 'b', 'Brothers in Arms', 'Win 10 team matches', { kind: 'team_wins', goal: 10 }),
            a('lightning_war', 'bolt', 's', 'Lightning War', 'Win a match shorter than 15 minutes', { kind: 'short_win', maxSeconds: 15 * 60 }),
            a('endless_siege', 'clock', 'b', 'Endless Siege', 'Win a match longer than 60 minutes', { kind: 'long_win', minSeconds: 60 * 60 }),
        ],
    },
    {
        id: 'community', enamel: 6, name: 'Community', items: [
            DIPLOMAT,
            a('host', 'host', 's', 'Host', 'Create 20 rooms that get played', { kind: 'host', goal: 20 }),
            CHAMPION,
            a('organiser', 'bracket', 's', 'Organiser', 'Organise a tournament that reaches the end', { kind: 'organiser' }),
        ],
    },
];

/** The Asian Dynasties: the game's own medals, the two competitive groups, and the general ones. */
export const TAD_SET: readonly AchievementGroup[] = [
    {
        id: 'expansions', enamel: 0, name: 'The three expansions', items: [
            a('old_world', 'crown', 's', 'Old World', 'Win with the 8 European civilizations', { kind: 'family_civ_wins', family: 'european' }),
            a('war_chiefs', 'feather', 'b', 'War Chiefs', 'Win with the 3 native civilizations', { kind: 'family_civ_wins', family: 'native' }),
            a('asian_dynasties', 'star', 'b', 'Asian Dynasties', 'Win with the 3 Asian civilizations', { kind: 'family_civ_wins', family: 'asian' }),
            a('complete_empire', 'globe', 'g', 'The Complete Empire', 'Win with all 14 civilizations', { kind: 'family_civ_wins', family: 'all' }),
        ],
    },
    {
        id: 'rivalries', enamel: 1, name: 'Rivalries', items: [
            a('clash_of_civilizations', 'sword', 'b', 'Clash of Civilizations', 'Win with an Asian civilization against a European one',
                { kind: 'matchup_win', mine: 'asian', theirs: 'european' }),
            a('native_resistance', 'feather', 'b', 'Native Resistance', 'Win with a native civilization against a European one',
                { kind: 'matchup_win', mine: 'native', theirs: 'european' }),
            a('duel_of_dynasties', 'flag', 's', 'Duel of Dynasties', 'Win with Chinese against Japanese, or the other way round',
                { kind: 'matchup_win', mine: ['chinese'], theirs: ['japanese'], either: true }),
            a('mirror', 'people', 'b', 'Mirror', 'Win with the same civilization as your rival', { kind: 'mirror_win' }),
        ],
    },
    {
        id: 'maps', enamel: 4, name: 'Maps', items: [
            a('silk_road', 'compass', 'g', 'Silk Road', 'Win on every Asian map of the expansion', { kind: 'map_list_wins', maps: 'tad_asian' }),
            a('new_world', 'flag', 's', 'New World', 'Win on 10 maps of the Americas', { kind: 'map_list_wins', maps: 'tad_americas', goal: 10 }),
            a('globetrotter', 'globe', 's', 'Globetrotter', 'Play on 20 different maps', { kind: 'distinct_maps_played', goal: 20 }),
        ],
    },
    {
        id: 'room_rules', enamel: 5, name: 'Room rules', items: [
            // Game rules as the room stores them (src/lobbies/gameRules.ts): 1 Classic, 2-5 Treaty
            // 10/20/30/40, 6 Treaty - No Blockade, 7 King of the Hill.
            a('non_aggression_pact', 'check', 'b', 'Non-Aggression Pact', 'Win a match with treaty rules', { kind: 'rules_win', rules: [2, 3, 4, 5, 6] }),
            a('long_treaty', 'clock', 's', 'Long Treaty', 'Win a 40-minute treaty match', { kind: 'rules_win', rules: [5] }),
            a('king_of_the_hill', 'crown', 's', 'King of the Hill', 'Win a match with that rule', { kind: 'rules_win', rules: [7] }),
            a('classic', 'shield', 'b', 'Classic', 'Win a match with the Classic rules', { kind: 'rules_win', rules: [1] }),
        ],
    },
    COMPETITIVE_1V1,
    COMPETITIVE_TEAMS,
    {
        id: 'general', enamel: 6, name: 'General', items: [
            FIRST_BLOOD, CONQUEROR, UNSTOPPABLE, GIANT_SLAYER, PROMOTION, DIPLOMAT, CHAMPION,
        ],
    },
];

/**
 * Other spellings of a canonical civ key. The launcher sends the display name its own install
 * resolves, which is English only when the install keeps an English snapshot; a Spanish TAD sends
 * "Españoles". Keys are {@link civKeyRaw} of the variant.
 */
export const CIV_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    // Spanish TAD.
    'espanoles': 'spanish', 'britanicos': 'british', 'franceses': 'french', 'portugueses': 'portuguese',
    'holandeses': 'dutch', 'rusos': 'russians', 'alemanes': 'germans', 'otomanos': 'ottomans',
    'iroqueses': 'iroquois', 'aztecas': 'aztecs', 'japoneses': 'japanese', 'chinos': 'chinese',
    'indios': 'indians',
    // English variants of the same civilizations.
    'haudenosaunee': 'iroquois', 'lakota': 'sioux', 'aztec': 'aztecs', 'indian': 'indians',
    'russian': 'russians', 'german': 'germans', 'ottoman': 'ottomans',
});

/**
 * The civilizations a mod can be played with, as canonical keys ({@link civKey} of the English
 * display name). Only mods listed here get "Citizen of the World": a goal that moves with the
 * history, or a list with a campaign civilization in it, would make the medal unreachable.
 */
export const CIV_LISTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    wol: [
        'Ethiopians', 'Egyptians', 'Zulu', 'United States', 'Australians', 'Canadians', 'Chinese',
        'Indians', 'Japanese', 'Koreans', 'Austro-Hungarians', 'Belgians', 'British', 'Danes', 'Dutch',
        'French', 'Germans', 'Italians', 'Ottomans', 'Portuguese', 'Russians', 'Spanish', 'Swedes',
        'Argentines', 'Bolivians', 'Brazilians', 'Central Americans', 'Chileans', 'Colombians',
        'Haitians', 'Mexicans', 'Paraguayans', 'Peruvians', 'Uruguayans', 'Afghans', 'Persians',
        'Saudis', 'Uzbeks', 'Bulgarians', 'Greeks', 'Romanians', 'Serbians', 'Haudenosaunee', 'Inca',
        'Lakota', 'Mapuche', 'Tupi', 'Maori',
    ].map(civKey),
});

/** TAD's three families, by the English display name (the canonical key). */
export const TAD_FAMILIES: Readonly<Record<CivFamily, readonly string[]>> = Object.freeze({
    european: ['spanish', 'british', 'french', 'portuguese', 'dutch', 'russians', 'germans', 'ottomans'],
    native: ['iroquois', 'sioux', 'aztecs'],
    asian: ['japanese', 'chinese', 'indians'],
});

/** TAD's maps, by {@link mapKeyRaw} of the script name (RM3). */
export const MAP_LISTS: Readonly<Record<MapList, readonly string[]>> = Object.freeze({
    tad_asian: ['borneo', 'ceylon', 'deccan', 'himalayas', 'honshu', 'indochina', 'mongolia', 'siberia', 'silkroad', 'yellowriverdry'],
    tad_americas: [
        'amazonia', 'andes', 'araucania', 'bayou', 'california', 'caribbean', 'carolina', 'greatlakes',
        'greatplains', 'hispaniola', 'newengland', 'northwestterritory', 'orinoco', 'ozarks',
        'painteddesert', 'pampas', 'patagonia', 'plymouth', 'rockies', 'saguenay', 'sonora', 'texas',
        'yucatan', 'yukon',
    ],
});

/** Other script names of the same map: a size or a mode of it, or its display name. */
export const MAP_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    'himalayasupper': 'himalayas', 'honshuregicide': 'honshu', 'yellowriver': 'yellowriverdry',
    'yellowriverbed': 'yellowriverdry', 'yellowriverwet': 'yellowriverdry',
});

/** Lowercase, accents off, only letters and digits. The raw form both lists above are keyed by. */
export function civKeyRaw(name: string): string {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The canonical key of a stored civilization name, or '' for none. */
export function civKey(name: string | null | undefined): string {
    if (!name) return '';
    const raw = civKeyRaw(name);
    return CIV_ALIASES[raw] ?? raw;
}

/** The raw key of a map name: no pack prefix, no "Large", only letters and digits. */
export function mapKeyRaw(name: string): string {
    // A pack prefix — "ESOC_Baja California", "ESOC Yukon" — is 2-8 capitals or digits before the
    // first separator, the launcher's LocalMatchView.MapLabel rule.
    const stripped = name.trim().replace(/^[A-Z0-9]{2,8}[_ ](?=\S)/, '');
    const key = stripped.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return key.endsWith('large') && key.length > 5 ? key.slice(0, -5) : key;
}

/** The canonical key of a stored map name, or '' for none. */
export function mapKey(name: string | null | undefined): string {
    if (!name) return '';
    const raw = mapKeyRaw(name);
    return MAP_ALIASES[raw] ?? raw;
}

/** The groups a game's medals come in, with "Citizen of the World" only where the civ list is known. */
export function catalogFor(modKey: string): readonly AchievementGroup[] {
    if (modKey === TAD_KEY) return TAD_SET;
    if (CIV_LISTS[modKey]) return GENERAL_SET;
    return GENERAL_SET.map((g) => g.id !== 'civs_maps'
        ? g
        : { ...g, items: g.items.filter((i) => i.rule.kind !== 'every_civ_win') });
}

/** How many medals a game has: one per achievement, five for Promotion. */
export function medalCount(modKey: string): number {
    let n = 0;
    for (const g of catalogFor(modKey)) for (const i of g.items) n += i.rule.kind === 'promotion' ? PROMOTION_TIERS.length : 1;
    return n;
}

/** One achievement of a game with the group it sits in, or null when the game has no such medal. */
export function defOf(modKey: string, id: string): { def: AchievementDef; group: AchievementGroup } | null {
    for (const group of catalogFor(modKey)) {
        for (const def of group.items) if (def.id === id) return { def, group };
    }
    return null;
}

/** Every achievement of a game, flat, in catalogue order. */
export function allOf(modKey: string): AchievementDef[] {
    return catalogFor(modKey).flatMap((g) => g.items);
}
