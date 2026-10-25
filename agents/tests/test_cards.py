"""Card payloads validate and stay <= 60 KB; the user-input parser maps every input form."""

import unittest
import uuid

import cards
from protocols import (
    BrandProfile, CompetitorAd, CompetitorIntel, CompetitorStat, IntelReport, LeaderEntry,
    LeaderRow, LearningNote, Pattern, Persona, RecipeItem, RecipePlan, RefreshJob, RefreshPick,
    RoundResult, RunFinished, VoiceItem, WinnerNote, WinningAd)
from uagents_core.contrib.protocols.chat import ChatMessage, MetadataContent, TextContent
from uagents_core.contrib.protocols.chat.cards import (
    create_card_response_content, extract_card, validate_card_payload)


def intel(n_winners: int = 3, text: str = "") -> IntelReport:
    return IntelReport(
        request_id="req_1", mode="test", dry=True,
        picks=[RefreshPick(kind="page", target="GHOST", ref_id="b1", reason="never synced")],
        jobs=[RefreshJob(job_id="j1", target="GHOST", status="skipped")],
        brand=BrandProfile(
            name="Magic Spoon", positioning="High-protein cereal" + text,
            proof_points=["13g protein", "0g sugar"],
            pains=[VoiceItem(label="price", quote="pricey" + text, frequency=41)],
            desires=[VoiceItem(label="guilt_free_snack", frequency=3)],
            objections=[VoiceItem(label="not_needing_cereal", frequency=2)],
            personas=[Persona(segment_id="seg_keto", name="Keto regulars", share=0.3)]),
        competitors=CompetitorIntel(
            competitors=[CompetitorStat(name="GHOST", ads=50, winners=12)],
            winners=[CompetitorAd(brand=f"Brand {i}", angle="taste_indulgence", hook="bold_claim",
                                  headline=f"Headline {i}" + text, days_running=10 * i,
                                  image_url="https://example.com/a.png" if i % 2 else "")
                     for i in range(n_winners)],
            patterns=[Pattern(concept="taste_indulgence", share=0.34)]))


def plan(blocked: str = "", n: int = 11) -> RecipePlan:
    recipes = [RecipeItem(arm_id=f"arm_{i:02d}", strategy="steal", angle="dietary_fit",
                          hook="problem_callout", rationale="because " * 30) for i in range(1, n + 1)]
    recipes.append(RecipeItem(arm_id="arm_control", strategy="control"))
    return RecipePlan(request_id="req_1", plan_id="plan_x", run_id="run_test_1025_0100",
                      rounds_planned=2, recipes=recipes,
                      segments=[Persona(segment_id="seg_a", name="Keto", share=0.2)],
                      check_ok=True, round0_complete=True, round0_expected=54, round0_ranked=54,
                      db_name="adlab-local", is_local=True, mode="test", runs_allowed=not blocked,
                      blocked_reason=blocked)


def round_result(r: int = 1, n_segments: int = 5, text: str = "") -> RoundResult:
    entry = LeaderEntry(arm_id="arm_07", recipe="Health nutrition × Testimonial" + text,
                        p_best=0.99, cpo_usd=10.09, share=0.61)
    return RoundResult(
        request_id="req_1", run_id="run_test_x", round=r, rounds_planned=2, impressions=705, buys=1,
        jev_cost_usd=0.04, cache_hit_rate=1.0,
        leaderboard=[LeaderRow(segment_id=f"seg_{i}", segment_name=f"Segment {i}" + text,
                               top=[entry, entry, entry],
                               control=LeaderEntry(arm_id="arm_control", cpo_usd=None))
                     for i in range(n_segments)],
        learnings_opened=[LearningNote(learning_id="l1", kind="claim_doubt", statement="doubt" + text)],
        winners=[WinnerNote(segment_id="seg_1", segment_name="Segment 1", recipe="H × T")],
        new_winners=["seg_1"], creatives_used=3)


def finished(n: int = 5, text: str = "") -> RunFinished:
    return RunFinished(request_id="req_1", run_id="run_test_x", rounds_completed=2, winners=[
        WinningAd(segment_id=f"seg_{i}", segment_name=f"Segment {i}", recipe="H × T",
                  declared=i % 2 == 0, cpo_usd=10.0, control_cpo_usd=55.0,
                  creative_id=f"cr_g2_run_test_x_arm_07_v{i}", headline="Headline" + text,
                  primary_text="Primary" + text, visual_description="Visual")
        for i in range(n)])


class CardPayloads(unittest.TestCase):
    def assert_card_ok(self, card, kind: str, terminal: bool):
        self.assertIsNotNone(card)
        self.assertEqual(card.kind, kind)
        self.assertEqual(card.is_terminal, terminal)
        validate_card_payload(card.kind, card.payload)  # raises if the shape is wrong
        block = cards.to_content(card)
        self.assertIsInstance(block, MetadataContent)
        self.assertLessEqual(len(block.metadata["card_payload"].encode()), 60_000)
        self.assertEqual(block.metadata["card_kind"], kind)
        self.assertEqual(block.metadata.get("is_terminal") == "true", terminal)
        parsed = extract_card(block)  # a client can read it back
        self.assertIsNotNone(parsed)
        self.assertTrue(card.text.strip(), "every card carries a plain-text narration")
        return block

    def test_brand_detail(self):
        card = cards.brand_card(intel())
        self.assert_card_ok(card, "detail", False)
        self.assertTrue(card.title.endswith(cards.TITLE_BRAND_SUFFIX))
        self.assertIn("price", card.text.lower())

    def test_competitors_carousel(self):
        card = cards.competitors_card(intel(n_winners=12))
        self.assert_card_ok(card, "carousel", False)
        self.assertEqual(card.title, cards.TITLE_COMPETITORS)
        self.assertLessEqual(len(card.payload["items"]), 8)
        self.assertIsNone(cards.competitors_card(intel(n_winners=0)))

    def test_recipes_review_and_go_selection(self):
        card = cards.recipes_card(plan())
        self.assert_card_ok(card, "review", False)
        self.assertEqual(card.payload["approve_cta"]["selection"],
                         {"action": "start_run", "plan_id": "plan_x"})
        self.assertIn("go", card.text)
        blocked = cards.recipes_card(plan(blocked="Runs are disabled on adlab-calhacks13"))
        self.assert_card_ok(blocked, "review", False)
        self.assertEqual(blocked.payload["approve_cta"]["selection"], {"action": "replan"})
        self.assertEqual(blocked.title, cards.TITLE_RECIPES_BLOCKED)

    def test_leaderboard_detail_terminal(self):
        card = cards.leaderboard_card(round_result(1))
        self.assert_card_ok(card, "detail", True)
        self.assertTrue(card.title.startswith("Round 1 of 2"))
        self.assertIn("Winner", card.text)

    def test_winners_carousel_terminal(self):
        card = cards.winners_card(finished())
        self.assert_card_ok(card, "carousel", True)
        self.assertEqual(card.title, cards.TITLE_WINNERS)
        sel = card.payload["items"][0]["primary_cta"]["selection"]
        self.assertEqual(sel["action"], "show_ad")
        self.assertIsNone(cards.winners_card(finished(n=0)))

    def test_huge_inputs_stay_under_60kb(self):
        big = "x" * 5000
        self.assert_card_ok(cards.leaderboard_card(round_result(1, n_segments=900, text=big)),
                            "detail", True)
        self.assert_card_ok(cards.recipes_card(plan(n=800)), "review", False)
        self.assert_card_ok(cards.winners_card(finished(n=700, text=big)), "carousel", True)
        self.assert_card_ok(cards.brand_card(intel(text=big)), "detail", False)
        self.assert_card_ok(cards.competitors_card(intel(n_winners=50, text=big)), "carousel", False)

    def test_round_trip_through_storage(self):
        card = cards.recipes_card(plan())
        again = cards.CardOut.from_dict(card.to_dict())
        self.assertEqual(again, card)


class ParseUserInput(unittest.TestCase):
    TABLE = [
        ('{"action":"start_run","plan_id":"p1"}', "go", {"plan_id": "p1"}, "json"),
        ('Sure: {"action": "start_run", "plan_id": "p2"} thanks', "go", {"plan_id": "p2"}, "json"),
        ('{"action":"status"}', "status", {}, "json"),
        ("Start the run", "go", {}, "prose"),
        ("The user selected Start the run", "go", {}, "prose"),
        ("go", "go", {}, "prose"),
        ("Go!", "go", {}, "prose"),
        ("start", "go", {}, "prose"),
        ("yes", "go", {}, "prose"),
        ("run it", "go", {}, "prose"),
        ("approve", "go", {}, "prose"),
        ("not now", "cancel", {}, "prose"),
        ("cancel", "cancel", {}, "prose"),
        ("status", "status", {}, "prose"),
        ("how's it going?", "status", {}, "prose"),
        ("find ads that beat Magic Spoon's current ones", "request", {}, "prose"),
        ("help", "help", {}, "prose"),
        ("hello there", "help", {}, "prose"),
        ("new run", "retry", {}, "prose"),
        ("check again", "replan", {}, "prose"),
        ("show me cr_g1_run_x_arm_07_v1", "show_ad", {"creative_id": "cr_g1_run_x_arm_07_v1"}, "prose"),
        ("qwerty", "unknown", {}, "prose"),
    ]

    def test_table(self):
        for text, intent, args, source in self.TABLE:
            with self.subTest(text=text):
                ui = cards.parse_user_input(ChatMessage(content=[TextContent(text)]))
                self.assertEqual(ui.intent, intent)
                for k, v in args.items():
                    self.assertEqual(ui.args.get(k), v)
                self.assertEqual(ui.source, source)

    def test_card_response_selection(self):
        block = create_card_response_content(card_id=uuid.uuid4(),
                                             selection={"action": "start_run", "plan_id": "p3"})
        ui = cards.parse_user_input(ChatMessage(content=[block]))
        self.assertEqual((ui.intent, ui.args, ui.source), ("go", {"plan_id": "p3"}, "card"))

    def test_card_response_wins_over_text(self):
        block = create_card_response_content(selection={"action": "cancel", "plan_id": "p3"})
        ui = cards.parse_user_input(ChatMessage(content=[TextContent("go"), block]))
        self.assertEqual((ui.intent, ui.source), ("cancel", "card"))

    def test_card_response_cancelled_and_show_card(self):
        ui = cards.parse_user_input(ChatMessage(content=[create_card_response_content(cancelled=True)]))
        self.assertEqual(ui.intent, "cancel")
        block = create_card_response_content(selection={"action": "show_card", "card": "competitors"})
        ui = cards.parse_user_input(ChatMessage(content=[block]))
        self.assertEqual((ui.intent, ui.args), ("show_card", {"card": "competitors"}))

    def test_card_request_block_is_not_a_response(self):
        block = cards.to_content(cards.recipes_card(plan()))
        ui = cards.parse_user_input(ChatMessage(content=[block]))
        self.assertEqual(ui.intent, "unknown")


if __name__ == "__main__":
    unittest.main()
