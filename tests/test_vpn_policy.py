import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('policy', Path(__file__).resolve().parents[1] / 'vpn_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
A, B, C = ('teltonika-' + letter * 8 for letter in 'abc')


class PolicyTests(unittest.TestCase):
    def test_master_children_without_child_to_child_permissions(self):
        addresses = {A: '10.80.0.2', B: '10.80.0.3', C: '10.80.0.4'}
        script = policy.rules({'mode': 'groups', 'groups': [{'name': 'Test', 'master': A, 'children': [B]}]}, addresses)
        self.assertIn('10.80.0.2 . 10.80.0.3', script)
        self.assertIn('10.80.0.3 . 10.80.0.2', script)
        self.assertNotIn('10.80.0.4 .', script)
        group = policy.rules({'mode': 'groups', 'groups': [{'name': 'Star', 'master': A, 'children': [B, C]}]}, addresses)
        self.assertIn('10.80.0.2 . 10.80.0.4', group)
        self.assertIn('10.80.0.4 . 10.80.0.2', group)
        self.assertNotIn('10.80.0.3 . 10.80.0.4', group)
        self.assertNotIn('10.80.0.4 . 10.80.0.3', group)
        self.assertIn('iifname "tun0" counter drop', script)
        isolated = policy.rules({'mode': 'isolated', 'groups': [{'name': 'Test', 'master': A, 'children': [B]}]}, addresses)
        self.assertNotIn('add element', isolated)
        revoked = policy.rules({'mode': 'groups', 'groups': [{'name': 'Test', 'master': A, 'children': [B]}]}, {A: '10.80.0.2'})
        self.assertNotIn('add element', revoked)

    def test_reservations_survive_disconnect_restart_and_revocation(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = policy.STATE
            policy.STATE = Path(directory)
            try:
                (policy.STATE / 'ipp.txt').write_text(f'{B},10.80.0.2,\n')
                first = policy.assign_addresses([A, B])
                self.assertEqual(first[B], '10.80.0.2')
                self.assertEqual(first[A], '10.80.0.3')
                policy.assign_addresses([])
                later = policy.assign_addresses([A, B, C])
                self.assertEqual(later[B], first[B])
                self.assertEqual(later[A], first[A])
                self.assertEqual(later[C], '10.80.0.4')
                policy.assign_addresses([C])
                self.assertIn(B, json.loads((policy.STATE / 'vpn-addresses.json').read_text()))
                self.assertNotEqual(later[C], first[B])
                self.assertEqual(policy.learn_address(['add', first[A], A]), 0)
                self.assertEqual(policy.learn_address(['add', first[B], A]), 1)
            finally:
                policy.STATE = previous


if __name__ == '__main__':
    unittest.main()
