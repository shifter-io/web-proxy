import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


node = load('cap-cutover-node')
fleet = load('cap-cutover')


class CutoverTests(unittest.TestCase):
    def test_promoted_loader_is_verified_without_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'BUILD.txt').write_text('commit=test\n')
            before = {'release': directory, 'loader_version': '1.0.12', 'dual': 'true'}
            with mock.patch.object(node, 'check', return_value=before), mock.patch.object(node, 'verify_served_sdk') as verify, mock.patch.object(node, 'run') as run:
                result = node.main({'node': {}, 'mode': 'loader', 'apply': True, 'commit': 'test'})
                self.assertEqual(result['result'], 'already_current')
                verify.assert_called_once_with({}, root)
                run.assert_not_called()

    def test_real_cap_missing_token_and_network_errors(self):
        self.assertTrue(node.rejected_by_verifier(404, {'success': False, 'error': 'Token not found'}))
        self.assertFalse(node.rejected_by_verifier(404, {}))
        self.assertFalse(node.rejected_by_verifier(403, {'success': False, 'error': 'Invalid secret'}))
        self.assertFalse(node.rejected_by_verifier(404, {'success': False, 'error': 'Site not found'}))
        self.assertFalse(node.rejected_by_verifier(500, {'success': False}))
        self.assertFalse(node.rejected_by_verifier(200, {'success': True}))

    def test_rollback_keeps_both_verifiers(self):
        text = node.render('recaptcha', 'https://cap.invalid', 'https://cap.invalid:8443').decode()
        self.assertIn('CAPTCHA_ACCEPT_BOTH=true', text)
        self.assertNotIn('secret=', text)

    def test_reject_injected_environment(self):
        for url in ['http://cap.invalid', 'https://cap.invalid\nINJECT=true', 'https://cap.invalid/path', 'https://user@cap.invalid']:
            with self.assertRaises(RuntimeError):
                node.render('cap', url, 'https://cap.invalid')

    def test_scope_rejected(self):
        with self.assertRaises(RuntimeError):
            fleet.selected_nodes({'project_id': 'other', 'deployment_tag': 'tag'}, 'project', 'tag')

    def test_loader_preserves_original_and_immutable_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'release'
            (root / 'web/sdk/v1').mkdir(parents=True)
            (root / 'web/sdk/releases/1.0.12').mkdir(parents=True)
            loader = root / 'web/sdk/v1/shifter-web-proxy.js'
            loader.write_text("const RELEASE = '1.0.10';")
            (root / 'web/sdk/releases/1.0.12/client.js').write_text('immutable')
            (root / 'BUILD.txt').write_text('commit=test\n')
            promoted = node.promote_loader(root)
            self.assertIn('1.0.10', loader.read_text())
            self.assertIn('1.0.12', (promoted / 'web/sdk/v1/shifter-web-proxy.js').read_text())
            self.assertEqual((promoted / 'web/sdk/releases/1.0.12/client.js').read_text(), 'immutable')
            self.assertEqual(promoted.stat().st_mode & 0o777, 0o755)


if __name__ == '__main__':
    unittest.main()
