/**
 * The achievements (design 121 "Logros"): which medals exist, in which game, and what each asks.
 *
 * <p><b>Counted per game.</b> Every medal is earned by a match (or tournament) OF THAT GAME, keyed
 * by the room's mod id lowercased ({@link modKeyOf}). The Asian Dynasties ({@link TAD_KEY}) and Wars
 * of Liberty ({@link WOL_SET}: the general medals plus its continents and historical wars) have sets
 * of their own; every other mod uses the {@link GENERAL_SET}.</p>
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

/** Bronze, silver, gold, and platinum for the feats (2026-11-26; an older launcher draws it as bronze). */
export type Metal = 'b' | 's' | 'g' | 'p';
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
    | { kind: 'on_top'; places?: number }
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
    | { kind: 'champion'; goal?: number }
    | { kind: 'organiser' }
    | { kind: 'distinct_days_played'; goal: number }
    | { kind: 'revenge' }
    | { kind: 'formats_won'; formats: readonly string[] }
    | { kind: 'quick_wins'; goal: number }
    | { kind: 'tournament_played' }
    | { kind: 'finalist' }
    | { kind: 'civ_set_wins'; civs: readonly string[] }
    | { kind: 'rated_win_streak'; ladder: Ladder; goal: number }
    | { kind: 'collector'; share: number };

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
    /** The enamel colour the launcher paints the group's medals with: 0-6 design 121's table, 7 the feats' steel. */
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

// Beyond design 121 (2026-11-26): long goals for veterans, quick match, tournaments and three
// small ones. Every game has them; they reuse the 21 icons the launcher already draws, so an
// older launcher shows them too (with the English name sent alongside).
const FIELD_MARSHAL = a('field_marshal', 'star', 'g', 'Field Marshal', 'Play 500 matches', { kind: 'played', goal: 500 });
const STEADFAST = a('steadfast', 'clock', 's', 'Steadfast', 'Play on 30 different days', { kind: 'distinct_days_played', goal: 30 });
const INVINCIBLE = a('invincible', 'flame', 'g', 'Invincible', 'Win 10 matches in a row', { kind: 'win_streak', goal: 10 });
const REVENGE = a('revenge', 'sword', 'b', 'Revenge', 'Win a 1v1 against the player who beat you the last time you met', { kind: 'revenge' });
const COSMOPOLITAN = a('cosmopolitan', 'globe', 'g', 'Cosmopolitan', 'Play against 100 different players', { kind: 'distinct_opponents', goal: 100 });
const ALL_ROUNDER = a('all_rounder', 'star', 's', 'All-Rounder', 'Win a 1v1, a 2v2 and a 3v3', { kind: 'formats_won', formats: ['1v1', '2v2', '3v3'] });
const READY_FOR_BATTLE = a('ready_for_battle', 'bolt', 'b', 'Ready for Battle', 'Win a quick match', { kind: 'quick_wins', goal: 1 });
const SKIRMISHER = a('skirmisher', 'bolt', 's', 'Skirmisher', 'Win 10 quick matches', { kind: 'quick_wins', goal: 10 });
const MINUTEMAN = a('minuteman', 'target', 'g', 'Minuteman', 'Win 50 quick matches', { kind: 'quick_wins', goal: 50 });
const IN_THE_BRACKET = a('in_the_bracket', 'bracket', 'b', 'In the Bracket', 'Play a tournament match', { kind: 'tournament_played' });
const FINALIST = a('finalist', 'trophy', 's', 'Finalist', 'Play the final of a tournament', { kind: 'finalist' });

const FIRST_STEPS: AchievementGroup = {
    id: 'first_steps', enamel: 0, name: 'First steps', items: [
        a('baptism_of_fire', 'sword', 'b', 'Baptism of Fire', 'Play your first multiplayer match', { kind: 'played', goal: 1 }),
        FIRST_BLOOD,
        a('veteran', 'shield', 's', 'Veteran', 'Play 100 matches', { kind: 'played', goal: 100 }),
        CONQUEROR,
        FIELD_MARSHAL,
        STEADFAST,
    ],
};

const STREAKS_RANKING: AchievementGroup = {
    id: 'streaks_ranking', enamel: 1, name: 'Streaks and ranking', items: [
        UNSTOPPABLE,
        INVINCIBLE,
        a('phoenix', 'phoenix', 'b', 'Phoenix', 'Win after losing 3 in a row', { kind: 'phoenix', losses: 3 }),
        REVENGE,
        GIANT_SLAYER,
        a('graduate', 'cap', 'b', 'Graduate', 'Finish your placement matches', { kind: 'graduate', ladder: 'default' }),
        PROMOTION,
        a('on_top', 'crown', 'g', 'On Top', 'Enter the podium (top 3)', { kind: 'on_top' }),
    ],
};

const AMBASSADOR = a('ambassador', 'flag', 's', 'Ambassador', 'Win with 10 different civilizations', { kind: 'distinct_civ_wins', goal: 10 });
const CITIZEN = a('citizen_of_the_world', 'globe', 'g', 'Citizen of the World', 'Win with every civilization of the mod', { kind: 'every_civ_win' });
const SPECIALIST = a('specialist', 'star', 's', 'Specialist', 'Win 25 matches with the same civilization', { kind: 'same_civ_wins', goal: 25 });
const CARTOGRAPHER = a('cartographer', 'compass', 's', 'Cartographer', 'Play on 20 different maps', { kind: 'distinct_maps_played', goal: 20 });

const FORMATS: AchievementGroup = {
    id: 'formats', enamel: 5, name: 'Formats', items: [
        a('brothers_in_arms', 'people', 'b', 'Brothers in Arms', 'Win 10 team matches', { kind: 'team_wins', goal: 10 }),
        ALL_ROUNDER,
        a('lightning_war', 'bolt', 's', 'Lightning War', 'Win a match shorter than 15 minutes', { kind: 'short_win', maxSeconds: 15 * 60 }),
        a('endless_siege', 'clock', 'b', 'Endless Siege', 'Win a match longer than 60 minutes', { kind: 'long_win', minSeconds: 60 * 60 }),
        READY_FOR_BATTLE,
        SKIRMISHER,
        MINUTEMAN,
    ],
};

const COMMUNITY: AchievementGroup = {
    id: 'community', enamel: 6, name: 'Community', items: [
        DIPLOMAT,
        COSMOPOLITAN,
        a('host', 'host', 's', 'Host', 'Create 20 rooms that get played', { kind: 'host', goal: 20 }),
        IN_THE_BRACKET,
        FINALIST,
        CHAMPION,
        a('organiser', 'bracket', 's', 'Organiser', 'Organise a tournament that reaches the end', { kind: 'organiser' }),
    ],
};

/**
 * The feats (2026-11-26): very hard, never impossible — each is a step past a medal somebody already
 * holds, or a place that somebody always occupies. Platinum, last in every game. "Living Legend" is
 * three in four of the game's other medals, counting the stored ones (a medal is never lost).
 */
const FEATS: AchievementGroup = {
    id: 'feats', enamel: 7, name: 'Feats', items: [
        a('grandmaster', 'climb', 'p', 'Grandmaster', 'Reach 1900 ELO in 1v1', { kind: 'elo', ladder: 'default', goal: 1900 }),
        a('number_one', 'crown', 'p', 'Number One', 'Be first on a ranking of 10 or more', { kind: 'on_top', places: 1 }),
        a('iron_streak', 'flame', 'p', 'Iron Streak', 'Win 10 competitive 1v1 matches in a row', { kind: 'rated_win_streak', ladder: 'default', goal: 10 }),
        a('centurion', 'sword', 'p', 'Centurion', 'Win 100 competitive 1v1 matches', { kind: 'rated_won', ladder: 'default', goal: 100 }),
        a('legion', 'people', 'p', 'Legion', 'Win 100 competitive team matches', { kind: 'rated_won', ladder: 'team', goal: 100 }),
        a('emperor', 'shield', 'p', 'Emperor', 'Win 250 matches', { kind: 'won', goal: 250 }),
        a('virtuoso', 'flag', 'p', 'Virtuoso', 'Win 100 matches with the same civilization', { kind: 'same_civ_wins', goal: 100 }),
        a('triple_crown', 'trophy', 'p', 'Triple Crown', 'Win 3 tournaments', { kind: 'champion', goal: 3 }),
        a('living_legend', 'star', 'p', 'Living Legend', 'Earn three in four of this game\'s medals', { kind: 'collector', share: 0.75 }),
    ],
};

/** Every mod without a set of its own. Wars of Liberty's ({@link WOL_SET}) is this plus its civilizations. */
export const GENERAL_SET: readonly AchievementGroup[] = [
    FIRST_STEPS,
    STREAKS_RANKING,
    COMPETITIVE_1V1,
    COMPETITIVE_TEAMS,
    { id: 'civs_maps', enamel: 4, name: 'Civilizations and maps', items: [AMBASSADOR, CITIZEN, SPECIALIST, CARTOGRAPHER] },
    FORMATS,
    COMMUNITY,
    FEATS,
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
            FIRST_BLOOD, CONQUEROR, FIELD_MARSHAL, STEADFAST, UNSTOPPABLE, INVINCIBLE, REVENGE, GIANT_SLAYER, PROMOTION,
        ],
    },
    {
        id: 'formats', enamel: 5, name: 'Formats', items: [ALL_ROUNDER, READY_FOR_BATTLE, SKIRMISHER, MINUTEMAN],
    },
    {
        id: 'community', enamel: 0, name: 'Community', items: [DIPLOMAT, COSMOPOLITAN, IN_THE_BRACKET, FINALIST, CHAMPION],
    },
    FEATS,
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

const civs = (...names: string[]): readonly string[] => names.map(civKey);

/**
 * Wars of Liberty's civilizations by continent. Together they are the whole of {@link CIV_LISTS}.wol,
 * each exactly once (catalog.test.ts pins it), so the four are the steps to "Citizen of the World".
 */
export const WOL_CONTINENTS = Object.freeze({
    africa_oceania: civs('Ethiopians', 'Egyptians', 'Zulu', 'Australians', 'Maori'),
    eastern_empires: civs('Chinese', 'Indians', 'Japanese', 'Koreans', 'Afghans', 'Persians', 'Saudis', 'Uzbeks'),
    old_continent: civs(
        'Austro-Hungarians', 'Belgians', 'British', 'Danes', 'Dutch', 'French', 'Germans', 'Italians',
        'Ottomans', 'Portuguese', 'Russians', 'Spanish', 'Swedes', 'Bulgarians', 'Greeks', 'Romanians', 'Serbians'),
    the_americas: civs(
        'United States', 'Canadians', 'Argentines', 'Bolivians', 'Brazilians', 'Central Americans', 'Chileans',
        'Colombians', 'Haitians', 'Mexicans', 'Paraguayans', 'Peruvians', 'Uruguayans',
        'Haudenosaunee', 'Inca', 'Lakota', 'Mapuche', 'Tupi'),
});

/** The former Spanish colonies Wars of Liberty plays (not Brazil, Portuguese; not Haiti, French). */
const SPANISH_AMERICA = civs(
    'Argentines', 'Bolivians', 'Central Americans', 'Chileans', 'Colombians', 'Mexicans',
    'Paraguayans', 'Peruvians', 'Uruguayans');

const war = (id: string, icon: string, metal: Metal, name: string, condition: string,
    one: readonly string[], other: readonly string[]): AchievementDef =>
    a(id, icon, metal, name, condition, { kind: 'matchup_win', mine: one, theirs: other, either: true });

const continent = (id: keyof typeof WOL_CONTINENTS, icon: string, metal: Metal, name: string, condition: string) =>
    a(id, icon, metal, name, condition, { kind: 'civ_set_wins', civs: WOL_CONTINENTS[id] });

/** Wars of Liberty: the general set, its civilizations by continent, and the wars of the century. */
export const WOL_SET: readonly AchievementGroup[] = [
    FIRST_STEPS,
    STREAKS_RANKING,
    COMPETITIVE_1V1,
    COMPETITIVE_TEAMS,
    {
        id: 'civs_maps', enamel: 4, name: 'Civilizations and maps', items: [
            AMBASSADOR,
            continent('africa_oceania', 'compass', 'b', 'Africa and Oceania', 'Win with each civilization of Africa and Oceania'),
            continent('eastern_empires', 'star', 's', 'Eastern Empires', 'Win with each civilization of Asia'),
            continent('old_continent', 'crown', 's', 'Old Continent', 'Win with each civilization of Europe'),
            continent('the_americas', 'flag', 's', 'The Americas', 'Win with each civilization of the Americas'),
            CITIZEN,
            SPECIALIST,
            CARTOGRAPHER,
        ],
    },
    {
        id: 'historical_wars', enamel: 1, name: 'Historical wars', items: [
            war('war_triple_alliance', 'people', 'b', 'Triple Alliance', 'Win Paraguayans vs Argentines, Brazilians or Uruguayans, either side',
                civs('Paraguayans'), civs('Argentines', 'Brazilians', 'Uruguayans')),
            war('war_pacific', 'compass', 'b', 'War of the Pacific', 'Win Chileans vs Peruvians or Bolivians, either side',
                civs('Chileans'), civs('Peruvians', 'Bolivians')),
            war('war_independence', 'flag', 'b', 'Independence', 'Win a former Spanish colony vs Spain, either side',
                SPANISH_AMERICA, civs('Spanish')),
            war('war_crimean', 'shield', 'b', 'Crimean War', 'Win Russians vs Ottomans, British or French, either side',
                civs('Russians'), civs('Ottomans', 'British', 'French')),
            war('war_mexican_american', 'target', 's', 'Mexican-American War', 'Win Mexicans vs the United States, either side',
                civs('Mexicans'), civs('United States')),
            war('war_franco_prussian', 'crown', 's', 'Franco-Prussian War', 'Win French vs Germans, either side',
                civs('French'), civs('Germans')),
            war('war_anglo_zulu', 'sword', 's', 'Anglo-Zulu War', 'Win British vs Zulu, either side',
                civs('British'), civs('Zulu')),
            war('war_russo_japanese', 'star', 's', 'Russo-Japanese War', 'Win Russians vs Japanese, either side',
                civs('Russians'), civs('Japanese')),
        ],
    },
    FORMATS,
    COMMUNITY,
    FEATS,
];

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
    if (modKey === 'wol') return WOL_SET;
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

/** How many of a game's other medals "Living Legend" asks: the share of all of them but itself, rounded up. */
export function collectorGoal(modKey: string, share = 0.75): number {
    return Math.ceil(share * (medalCount(modKey) - 1));
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
