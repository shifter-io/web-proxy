import hashlib
import importlib.util
import io
import tarfile
import tempfile
import unittest
import stat
from pathlib import Path


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'scripts' / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


node = module('native-release-node')
rollout = module('native-release-rollout')
COMMIT = 'a' * 40


class NativeReleaseTests(unittest.TestCase):
    def test_release_root_is_traversable_after_private_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            root.chmod(0o700)
            (root / 'web').mkdir(mode=0o700)
            (root / 'shifter-web').write_text('binary')
            (root / 'web' / 'index.html').write_text('asset')
            node.release_permissions(root)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((root / 'web').stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((root / 'shifter-web').stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((root / 'web/index.html').stat().st_mode), 0o644)

    def package(self, path, extra=None, wrong_digest=False):
        binary = bytearray(24)
        binary[:6] = b'\x7fELF\x02\x01'
        binary[18:20] = b'\x3e\x00'
        files = {'BUILD.txt': ('commit=' + COMMIT + '\n').encode(), 'shifter-web': bytes(binary)}
        sums = '\n'.join(hashlib.sha256(v).hexdigest() + '  ' + k for k, v in files.items())
        files['SHA256SUMS'] = (sums.replace('a', 'b') if wrong_digest else sums).encode()
        with tarfile.open(path, 'w:gz') as tar:
            for name, contents in files.items():
                info = tarfile.TarInfo('./' + name)
                info.size = len(contents)
                tar.addfile(info, io.BytesIO(contents))
            if extra:
                tar.addfile(extra)

    def test_good_package_and_wrong_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'release.tgz'
            self.package(path)
            node.validate_archive(path, COMMIT)
            with self.assertRaises(RuntimeError):
                node.validate_archive(path, 'b' * 40)

    def test_rejects_traversal_and_symlink(self):
        for kind in ['traversal', 'symlink']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                info = tarfile.TarInfo('../escape' if kind == 'traversal' else 'link')
                if kind == 'symlink':
                    info.type = tarfile.SYMTYPE
                    info.linkname = '/etc/passwd'
                path = Path(tmp) / 'release.tgz'
                self.package(path, extra=info)
                with self.assertRaises(RuntimeError):
                    node.validate_archive(path, COMMIT)

    def test_scope_is_fail_closed(self):
        data = {'project_id': 'project', 'deployment_tag': 'tag', 'nodes': [
            {'id': 1, 'hostname': 'web-node-fra1-01', 'role': 'node', 'region': 'fra1',
             'public_ip': '192.0.2.1', 'private_ip': '10.0.0.1', 'tags': ['tag']}]}
        self.assertEqual(len(rollout.targets(data, 'project', 'tag')), 1)
        with self.assertRaises(RuntimeError):
            rollout.targets(data, 'other', 'tag')
        data['nodes'].append(data['nodes'][0])
        with self.assertRaises(RuntimeError):
            rollout.targets(data, 'project', 'tag')


if __name__ == '__main__':
    unittest.main()
