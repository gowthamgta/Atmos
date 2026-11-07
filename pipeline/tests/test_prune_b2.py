import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import prune_b2


def test_list_cycles_parses_aws_output():
    fake_output = (
        "                           PRE 20261106T06Z/\n"
        "                           PRE 20261106T12Z/\n"
        "                           PRE 20261106T18Z/\n"
        "2026-11-06 20:00:00        123 latest.json\n"
    )
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(stdout=fake_output, returncode=0)
        cycles = prune_b2.list_cycles("test-bucket", "blend", "https://s3.endpoint")
        assert cycles == ["20261106T06Z", "20261106T12Z", "20261106T18Z"]


def test_prune_model_keeps_latest_n():
    with patch("prune_b2.list_cycles", return_value=["20261106T00Z", "20261106T06Z", "20261106T12Z", "20261106T18Z"]):
        with patch("prune_b2.delete_cycle", return_value=True) as mock_delete:
            pruned = prune_b2.prune_model("test-bucket", "blend", "https://s3.endpoint", keep=2)
            assert pruned == 2
            # Should have deleted the two oldest
            assert mock_delete.call_count == 2
            mock_delete.assert_any_call("test-bucket", "blend", "20261106T00Z", "https://s3.endpoint")
            mock_delete.assert_any_call("test-bucket", "blend", "20261106T06Z", "https://s3.endpoint")


def test_prune_model_under_threshold():
    with patch("prune_b2.list_cycles", return_value=["20261106T12Z", "20261106T18Z"]):
        with patch("prune_b2.delete_cycle") as mock_delete:
            pruned = prune_b2.prune_model("test-bucket", "blend", "https://s3.endpoint", keep=2)
            assert pruned == 0
            mock_delete.assert_not_called()
